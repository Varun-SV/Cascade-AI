import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildCloudConfig, parseChatRunPayload, remoteBrowserControls, runChatTurn } from './runs.js';
import { CloudStore } from './db.js';
import { loadEnv } from './env.js';
import { providerIsUsable, sharedBrowserGeneration, resetSharedBrowser } from './remote-browser.js';
import { RemoteBrowserController } from '#cascade-ai';
import { startStubOpenAIServer, type StubOpenAIServer } from './test-support/stub-openai-server.js';

class FakeSocket {
  events: Array<{ event: string; payload: unknown }> = [];
  emit(event: string, payload: unknown): boolean { this.events.push({ event, payload }); return true; }
  on(): this { return this; }
  off(): this { return this; }
}

/** The operator's environment, minus whatever this test is varying. */
function baseEnv(dir: string): NodeJS.ProcessEnv {
  return {
    PORT: '8787',
    SESSION_SECRET: 'x'.repeat(20),
    DATA_DIR: dir,
    WEB_ORIGIN: 'http://localhost:5173',
    OAUTH_REDIRECT_BASE_URL: 'http://localhost:8787',
    MAX_COST_PER_RUN_USD: '1',
  };
}

// Everything here starts from `loadEnv` and ends at a controller actually being
// built, because that is the span the bug lived in.
//
// The capability shipped complete and inert: the provider adapters, the
// controller, the lease, the live view and the client panel all existed and
// were tested, and `attachRemoteBrowser` read `config.tools.remoteBrowser` —
// which nothing on the cloud side ever wrote. There was no env var, no field on
// `RunControls`, and no line in `buildCloudConfig`. Every test passed because
// every test handed `attachRemoteBrowser` a config it had built by hand.
//
// So a test that starts at the config is not enough to catch it a second time:
// the operator's environment is where a real deployment starts.
describe('the operator configures a browser for their deployment', () => {
  let dir = '';
  let store: CloudStore | undefined;
  let stub: StubOpenAIServer | undefined;

  afterEach(async () => {
    await resetSharedBrowser();
    store?.close();
    store = undefined;
    if (dir) {
      for (let i = 0; i < 4; i++) {
        try { await fs.rm(dir, { recursive: true, force: true }); break; }
        catch { await new Promise((r) => setTimeout(r, 50)); }
      }
    }
    await stub?.close();
    stub = undefined;
  });

  it('carries REMOTE_BROWSER_* from the environment into the run config', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-rb-env-'));
    const env = loadEnv({
      ...baseEnv(dir),
      REMOTE_BROWSER_PROVIDER: 'cdp',
      REMOTE_BROWSER_URL: 'ws://browserless.internal:3000',
      REMOTE_BROWSER_MAX_SESSIONS: '3',
    });

    // THE mapping the run path performs, not a restatement of it. Rebuilding
    // the controls object here was the bug in this test: dropping `apiKey` or
    // `maxSessions` from the real mapping would have changed nothing it could
    // see, because it never called the real mapping at all.
    //
    // `browserMode: true` because the operator having configured a provider is
    // necessary and no longer sufficient — every session is billed, so the turn
    // has to ask for one. What is under test here is still the env mapping: that
    // every REMOTE_BROWSER_* value survives the trip into the run config.
    const config = buildCloudConfig([], env.MAX_COST_PER_RUN_USD, { ...remoteBrowserControls(env), browserMode: true });

    expect(config.tools?.remoteBrowser).toEqual({
      provider: 'cdp',
      url: 'ws://browserless.internal:3000',
      maxSessions: 3,
    });
  });

  it('leaves the config untouched when the operator configured nothing', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-rb-off-'));
    const env = loadEnv(baseEnv(dir));
    expect(env.REMOTE_BROWSER_PROVIDER).toBeUndefined();

    const config = buildCloudConfig([], env.MAX_COST_PER_RUN_USD, { ...remoteBrowserControls(env), browserMode: true });

    // Not "present but disabled" — absent. `setRemoteBrowserController` gates on
    // the field, so the tool is never registered and the model never sees it.
    expect(config.tools?.remoteBrowser).toBeUndefined();
  });

  it('builds the deployment browser during a real run, from env alone', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-rb-run-'));
    store = new CloudStore(path.join(dir, 'cloud.db'));
    stub = await startStubOpenAIServer();
    await resetSharedBrowser();

    const env = loadEnv({
      ...baseEnv(dir),
      REMOTE_BROWSER_PROVIDER: 'cdp',
      // Never dialled: a CDP session is opened on the first browser ACTION, and
      // small talk takes none. What is under test is that the run reaches the
      // point of having a browser configured at all.
      REMOTE_BROWSER_URL: 'ws://127.0.0.1:9/devtools/browser/test',
    });
    const user = store.upsertUser({ provider: 'dev', providerId: 'tester', email: null, name: 'Tester', avatar: null });

    const before = sharedBrowserGeneration();
    const payload = parseChatRunPayload({
      prompt: 'hello',
      providers: [{ type: 'openai-compatible', baseUrl: stub.url, apiKey: 'test-key', model: 'stub-model' }],
      // The turn has to ASK. Every session is billed, so an operator having
      // configured a provider is necessary and no longer sufficient — see
      // "withholds the browser entirely when this turn did not ask for it".
      browserMode: true,
    });
    const result = await runChatTurn(payload, {
      env, store, userId: user.id,
      socket: new FakeSocket() as unknown as import('socket.io').Socket,
    });

    expect(result.output).toContain('Hello from the stub model.');
    // A controller was built for this deployment. Asserting the run merely
    // succeeded would pass either way — it did before, with the feature inert.
    expect(sharedBrowserGeneration()).toBe(before + 1);
  }, 30_000);

  describe('the plan\u2019s daily allowance of browser sessions', () => {
    const today = () => new Date().toISOString().slice(0, 10);
    /**
     * `true` is OUR hosted Cascade deployment backed by private Steel, so its
     * browser spend is monetized by plan. `'self-hosted'` uses the same Steel
     * topology but represents an OSS operator paying for their own infrastructure.
     * `'cdp'` is a standing browser and allocates no sessions.
     */
    async function setup(withBrowser: boolean | 'cdp' | 'self-hosted') {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-rb-allowance-'));
      store = new CloudStore(path.join(dir, 'cloud.db'));
      stub = await startStubOpenAIServer();
      await resetSharedBrowser();
      const env = loadEnv({
        ...baseEnv(dir),
        ...(withBrowser === 'cdp'
          ? {
            CASCADE_DEPLOYMENT_MODE: 'hosted',
            REMOTE_BROWSER_PROVIDER: 'cdp',
            REMOTE_BROWSER_URL: 'ws://127.0.0.1:9/devtools/browser/test',
          }
          : withBrowser === 'self-hosted'
            ? {
              CASCADE_DEPLOYMENT_MODE: 'self-hosted',
              REMOTE_BROWSER_PROVIDER: 'steel',
              REMOTE_BROWSER_URL: 'https://steel.internal',
            }
            : withBrowser
              ? {
                CASCADE_DEPLOYMENT_MODE: 'hosted',
                REMOTE_BROWSER_PROVIDER: 'steel',
                REMOTE_BROWSER_URL: 'https://steel.internal',
              }
              : {}),
      });
      const user = store.upsertUser({ provider: 'dev', providerId: 'tester', email: null, name: 'Tester', avatar: null });
      const run = (browserMode: boolean, socket = new FakeSocket()) => runChatTurn(
        parseChatRunPayload({
          prompt: 'hello',
          providers: [{ type: 'openai-compatible', baseUrl: stub!.url, apiKey: 'test-key', model: 'stub-model' }],
          browserMode,
        }),
        { env, store: store!, userId: user.id, socket: socket as unknown as import('socket.io').Socket },
      );
      return { user, run };
    }

    it('lets an exhausted user start a Browser-mode run that never opens a browser', async () => {
      const { user, run } = await setup(true);
      for (let i = 0; i < 5; i++) store!.incrementBrowserSessions(user.id, today());

      const result = await run(true);
      expect(result.output).toContain('Hello from the stub model.');
      expect(store!.listConversations(user.id), 'the ordinary run is allowed to exist').toHaveLength(1);
      expect(store!.getBrowserSessions(user.id, today()), 'no browser opened, so nothing new was charged').toBe(5);
    }, 30_000);

    it('still lets the same person run without the browser', async () => {
      const { user, run } = await setup(true);
      for (let i = 0; i < 5; i++) store!.incrementBrowserSessions(user.id, today());

      const result = await run(false);
      expect(result.output).toContain('Hello from the stub model.');
    }, 30_000);

    it('does not ration a browser that opens no sessions — the operator\u2019s own CDP endpoint', async () => {
      // GenericCdpProvider allocates nothing, so there is nothing a day's
      // allowance could be spending. Five small-talk runs used to lock a Free
      // user out of the operator's browser for the rest of the day.
      const { user, run } = await setup('cdp');
      for (let i = 0; i < 5; i++) store!.incrementBrowserSessions(user.id, today());

      const result = await run(true);
      expect(result.output).toContain('Hello from the stub model.');
    }, 30_000);

    it('does not apply Cascade Cloud’s daily allowance to a self-hosted deployment', async () => {
      const { user, run } = await setup('self-hosted');
      for (let i = 0; i < 5; i++) store!.incrementBrowserSessions(user.id, today());

      const set = vi.spyOn(RemoteBrowserController.prototype, 'setAllowanceFor');
      try {
        const result = await run(true);
        expect(result.output).toContain('Hello from the stub model.');
        expect(set.mock.calls.at(-1)?.[1], 'self-hosted runs get no SaaS browser allowance').toBeUndefined();
      } finally {
        set.mockRestore();
      }
    }, 30_000);

    it('does not ration a browser the deployment does not have', async () => {
      const { user, run } = await setup(false);
      for (let i = 0; i < 5; i++) store!.incrementBrowserSessions(user.id, today());

      const result = await run(true);
      expect(result.output).toContain('Hello from the stub model.');
    }, 30_000);

    it('claims from the allowance when the run would open a session, and refuses once it is spent', async () => {
      // The allowance lives at the only boundary that costs browser capacity:
      // actual session creation. A Browser-mode run can exist with zero sessions,
      // while every new session still consumes exactly one plan allowance.
      const set = vi.spyOn(RemoteBrowserController.prototype, 'setAllowanceFor');
      try {
        const { user, run } = await setup(true);
        for (let i = 0; i < 4; i++) store!.incrementBrowserSessions(user.id, today());
        const socket = new FakeSocket();
        await run(true, socket);

        const allowance = set.mock.calls.at(-1)?.[1];
        expect(allowance?.take(), 'one left: claimed').toHaveProperty('giveBack');
        expect(store!.getBrowserSessions(user.id, today()), 'counted as it is claimed').toBe(5);
        expect(allowance?.take(), 'and the next is refused').toEqual({ refusal: expect.stringMatching(/browser sessions are used up/) });
        expect(socket.events.filter((e) => e.event === 'browser:limit'), 'the person is told').toHaveLength(1);
      } finally {
        set.mockRestore();
      }
    }, 30_000);
  });

  it('builds nothing when the operator configured no provider', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-rb-run-off-'));
    store = new CloudStore(path.join(dir, 'cloud.db'));
    stub = await startStubOpenAIServer();
    await resetSharedBrowser();

    const env = loadEnv(baseEnv(dir));
    const user = store.upsertUser({ provider: 'dev', providerId: 'tester', email: null, name: 'Tester', avatar: null });

    const before = sharedBrowserGeneration();
    await runChatTurn(
      parseChatRunPayload({
        prompt: 'hello',
        providers: [{ type: 'openai-compatible', baseUrl: stub.url, apiKey: 'test-key', model: 'stub-model' }],
      }),
      { env, store, userId: user.id, socket: new FakeSocket() as unknown as import('socket.io').Socket },
    );

    expect(sharedBrowserGeneration()).toBe(before);
  }, 30_000);

  it('ignores a browser endpoint supplied by the caller', async () => {
    // The endpoint is a URL the SERVER opens a connection to. Accepting it from
    // a request body would let any signed-in user aim that connection at the
    // deployment's own network — the SSRF this whole design exists to avoid.
    // It is operator config or it is nothing.
    const payload = parseChatRunPayload({
      prompt: 'hi',
      providers: [{ type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm' }],
      remoteBrowser: { provider: 'cdp', url: 'ws://169.254.169.254/' },
      tools: { remoteBrowser: { provider: 'cdp', url: 'ws://169.254.169.254/' } },
    } as Record<string, unknown>);

    expect((payload as Record<string, unknown>).remoteBrowser).toBeUndefined();
    expect((payload as Record<string, unknown>).tools).toBeUndefined();
  });
});

// Every field, not just the two the end-to-end test happens to exercise. That
// one asserts a controller was built, which is true as soon as provider+url
// arrive — so a dropped `apiKey` or `maxSessions` line would sail past it.
describe('the Browser control is advertised only where one can be built', () => {
  // The control exists so a deployment that cannot serve a browser does not
  // show a switch for one. Deciding that from the provider NAME alone put the
  // inert switch straight back: a `cdp` provider with a missing or
  // non-websocket URL passes the env schema and then fails at `buildProvider`.
  it('is not advertised for a cdp provider with no endpoint', () => {
    expect(providerIsUsable({ provider: 'cdp' })).toBe(false);
  });

  it('is not advertised for a cdp endpoint that is not a websocket', () => {
    // An http:// URL copied from a provider's docs is the likely mistake.
    expect(providerIsUsable({ provider: 'cdp', url: 'https://browser.example' })).toBe(false);
  });

  it('is advertised for a cdp endpoint that can actually be driven', () => {
    expect(providerIsUsable({ provider: 'cdp', url: 'ws://browser.internal:3000' })).toBe(true);
  });

  it('is not advertised for the hosted Steel API with no credential', () => {
    // This assertion used to read `is advertised for steel, which defaults its
    // own endpoint` and expect TRUE. Defaulting the URL is not the same as
    // being able to reach a browser: the hosted API refuses an unauthenticated
    // request, so the control appeared and the first action failed on
    // authentication.
    //
    // It was also the SECOND copy of that claim. I corrected the one in
    // `app.test.ts` and missed this one, which is the same mistake the rule
    // itself is about — a thing fixed at one of its two doors — committed
    // while writing the fix for exactly that.
    expect(providerIsUsable({ provider: 'steel' })).toBe(false);
  });

  it('is advertised for the hosted Steel API with a credential', () => {
    expect(providerIsUsable({ provider: 'steel', apiKey: 'sk-test' })).toBe(true);
  });

  it('is not advertised for the hosted URL typed out in full', () => {
    // The fourth shape, and the one that showed the first three fixes were all
    // asking the wrong question. Requiring a key only when `url` was ABSENT
    // treated "no url" and "https://api.steel.dev" as different configurations
    // when they are the same destination — so naming the hosted endpoint
    // explicitly bought an unauthenticated provider and an inert control.
    //
    // The check now asks where the request actually goes, which answers every
    // spelling of it at once.
    expect(providerIsUsable({ provider: 'steel', url: 'https://api.steel.dev' })).toBe(false);
    expect(providerIsUsable({ provider: 'steel', url: 'https://api.steel.dev/' }), 'a trailing slash is not a different host').toBe(false);
    expect(providerIsUsable({ provider: 'steel', url: 'https://API.Steel.DEV' }), 'nor is shouting').toBe(false);
    expect(providerIsUsable({ provider: 'steel', url: '' }), 'an empty url takes the default too').toBe(false);
    // The FULLY-QUALIFIED spelling, with the root label written out. `URL`
    // keeps the terminal dot, so compared literally the one spelling that
    // means "resolve exactly this" looked like somebody else's host — and the
    // parser accepts more than one dot, so stripping just the last is not
    // enough either.
    expect(providerIsUsable({ provider: 'steel', url: 'https://api.steel.dev.' }), 'an FQDN is the same service').toBe(false);
    expect(providerIsUsable({ provider: 'steel', url: 'https://API.Steel.DEV.' }), 'and shouting it does not help').toBe(false);
    expect(providerIsUsable({ provider: 'steel', url: 'https://api.steel.dev../v1' }), 'nor does doubling the dot').toBe(false);
  });

  it('is advertised for the hosted URL when a credential comes with it', () => {
    expect(providerIsUsable({ provider: 'steel', url: 'https://api.steel.dev', apiKey: 'sk-test' })).toBe(true);
  });

  it('is not advertised for a base a path cannot be appended to', () => {
    // `SteelProvider.call` builds every request as `${base}${path}`, so a base
    // carrying a query or a fragment cannot reach an endpoint: appending
    // `/v1/sessions` to `https://steel.internal?tenant=a` POSTs to `/` with
    // `?tenant=a/v1/sessions`. It parses, it looks like a URL, and the first
    // action fails — the inert control again, this time hiding behind a URL
    // that IS well-formed.
    expect(providerIsUsable({ provider: 'steel', url: 'https://steel.internal?tenant=a' })).toBe(false);
    expect(providerIsUsable({ provider: 'steel', url: 'https://steel.internal#frag' })).toBe(false);
    // A base PATH is fine and is the reason the concatenation exists — a Steel
    // behind a gateway prefix.
    expect(providerIsUsable({ provider: 'steel', url: 'https://steel.internal/api' }), 'a path prefix is legitimate').toBe(true);
  });

  it('does not count whitespace as a credential, all the way from the env', () => {
    // A trailing space survives a copy-paste, a here-doc or a dashboard field
    // without ever being visible. Untrimmed it is TRUTHY, so the hosted gate
    // read the deployment as authenticated, advertised the browser, and sent
    // whitespace as `steel-api-key` for the first request to be refused.
    //
    // Asserted from `loadEnv` through `remoteBrowserControls` to the gate
    // rather than by handing the gate a config directly: the normalisation
    // lives in the env schema, and a test that starts after it would pass
    // whether or not the schema does anything.
    const env = loadEnv({
      ...baseEnv('/tmp'),
      REMOTE_BROWSER_PROVIDER: 'steel',
      REMOTE_BROWSER_API_KEY: '   ',
    });
    expect(env.REMOTE_BROWSER_API_KEY, 'trimmed to nothing at the boundary').toBe('');
    expect(providerIsUsable(remoteBrowserControls(env).remoteBrowser), 'so the hosted gate refuses it').toBe(false);
  });

  it('does not let a padded URL through to be concatenated raw', () => {
    // The URL PARSER ignores surrounding spaces, so this validated cleanly —
    // and then `${base}${path}` produced `https://steel.internal /v1/sessions`.
    const env = loadEnv({
      ...baseEnv('/tmp'),
      REMOTE_BROWSER_PROVIDER: 'steel',
      REMOTE_BROWSER_URL: '  https://steel.internal  ',
      REMOTE_BROWSER_API_KEY: 'sk-test',
    });
    expect(env.REMOTE_BROWSER_URL, 'trimmed at the boundary').toBe('https://steel.internal');
    expect(remoteBrowserControls(env).remoteBrowser?.url).toBe('https://steel.internal');
  });

  it('is not advertised for a base whose delimiter swallows the endpoint', () => {
    // The seventh way a base could look fine and not work, and the one that
    // ended the sequence: a bare `?` or `#` leaves `search` and `hash` EMPTY
    // while `href` keeps the delimiter, so no component inspection could see
    // it. `${base}/v1/sessions` becomes `...?/v1/sessions` and the POST lands
    // on `/`.
    //
    // The check now builds the request `call()` will build and asks whether it
    // addresses the endpoint, so a spelling nobody has thought of fails by
    // construction rather than by being listed here.
    expect(providerIsUsable({ provider: 'steel', url: 'https://api.steel.dev?', apiKey: 'sk-test' })).toBe(false);
    expect(providerIsUsable({ provider: 'steel', url: 'https://api.steel.dev#', apiKey: 'sk-test' })).toBe(false);
    expect(providerIsUsable({ provider: 'steel', url: 'https://steel.internal?' })).toBe(false);
    expect(providerIsUsable({ provider: 'steel', url: 'https://steel.internal#' })).toBe(false);
  });

  it('is not advertised for a base carrying credentials fetch will not send', () => {
    // `https://user:pass@steel.internal` parses, has no query and no fragment,
    // and passes every earlier version of this check — and then Node's fetch
    // throws `Request cannot be constructed from a URL that includes
    // credentials` before a single byte goes out. Verified against fetch, not
    // assumed.
    //
    // Not a capability withheld: Steel's credential is `apiKey`, which becomes
    // a header. This is a spelling that cannot work, named at config time
    // rather than at the first browser action.
    expect(providerIsUsable({ provider: 'steel', url: 'https://user:pass@steel.internal' })).toBe(false);
    expect(providerIsUsable({ provider: 'steel', url: 'https://user@steel.internal' }), 'a username alone is enough to break it').toBe(false);
  });

  it('is not advertised on a port fetch will not open', () => {
    // The second member of the userinfo category, and the reason that test now
    // has a sibling: the URL is well-formed, the built request addresses
    // `/v1/sessions` exactly, and Node still refuses it —
    // `TypeError: fetch failed` with `cause: bad port` — before a packet
    // leaves. Verified against Node's fetch, not assumed.
    //
    // 6000 is X11 and 587 is mail submission; neither is a strange choice for
    // an internal service behind its own network, so this is an ordinary
    // deployment being advertised as usable and failing on its first call.
    expect(providerIsUsable({ provider: 'steel', url: 'http://steel.internal:6000' })).toBe(false);
    expect(providerIsUsable({ provider: 'steel', url: 'https://steel.internal:587' }), 'the scheme does not rescue it').toBe(false);
    expect(providerIsUsable({ provider: 'steel', url: 'http://steel.internal:6000/api' }), 'nor does a gateway prefix').toBe(false);
    // An ordinary high port is fine, which is what keeps this from being a
    // blanket refusal of non-default ports.
    expect(providerIsUsable({ provider: 'steel', url: 'http://steel.internal:3000' }), 'an unremarkable port still works').toBe(true);
    expect(providerIsUsable({ provider: 'steel', url: 'http://steel.internal:8080' })).toBe(true);
    // And the default ports, which `URL.port` reports as empty string — the
    // one value that must never match the list.
    expect(providerIsUsable({ provider: 'steel', url: 'http://steel.internal:80' })).toBe(true);
    expect(providerIsUsable({ provider: 'steel', url: 'https://steel.internal:443' })).toBe(true);
  });

  it('is not advertised for the hosted endpoint with a path prefix', () => {
    // A path prefix is the whole reason `call()` concatenates — a self-hosted
    // Steel behind a gateway lives at one. The hosted service does not, so
    // `https://api.steel.dev/v1` asks for `/v1/v1/sessions` and the first
    // action fails with a key present and everything else looking right.
    expect(providerIsUsable({ provider: 'steel', url: 'https://api.steel.dev/v1', apiKey: 'sk-test' })).toBe(false);
    // The bare host, with or without the root slash, is what the hosted API is.
    expect(providerIsUsable({ provider: 'steel', url: 'https://api.steel.dev', apiKey: 'sk-test' })).toBe(true);
    expect(providerIsUsable({ provider: 'steel', url: 'https://api.steel.dev/', apiKey: 'sk-test' })).toBe(true);
    // Extra trailing slashes normalise to the same working base — the provider
    // strips them before building a request, so refusing them here hid the
    // control for a deployment that would have worked. Every other finding on
    // this predicate was the opposite mistake, advertising something unusable;
    // this one was usable and refused.
    expect(providerIsUsable({ provider: 'steel', url: 'https://api.steel.dev//', apiKey: 'sk-test' }), 'the provider strips these').toBe(true);
    expect(providerIsUsable({ provider: 'steel', url: 'https://api.steel.dev///', apiKey: 'sk-test' }), 'however many there are').toBe(true);
    // A real path prefix still is one, with or without a trailing slash: the
    // provider keeps `/v1` and asks for `/v1/v1/sessions`.
    expect(providerIsUsable({ provider: 'steel', url: 'https://api.steel.dev/v1/', apiKey: 'sk-test' }), 'not a slash to be stripped').toBe(false);
    // And the same prefix stays valid for somebody else's endpoint, which is
    // the point: usability depends on the destination, not only on the shape.
    expect(providerIsUsable({ provider: 'steel', url: 'https://steel.internal/v1' }), 'legitimate for a self-hosted gateway').toBe(true);
  });

  it('is not advertised for the hosted endpoint over cleartext', () => {
    // The only finding on this predicate that is a SECURITY one rather than an
    // availability one. `http://api.steel.dev` parses, addresses the endpoint
    // and is recognised as hosted — so the key gate is satisfied and the
    // credential goes out in cleartext on the very first request. A redirect to
    // https cannot save it: the header is already on the wire.
    expect(providerIsUsable({ provider: 'steel', url: 'http://api.steel.dev', apiKey: 'sk-test' })).toBe(false);
    expect(providerIsUsable({ provider: 'steel', url: 'http://api.steel.dev/' }), 'with or without a key').toBe(false);
    expect(providerIsUsable({ provider: 'steel', url: 'http://api.steel.dev.', apiKey: 'sk-test' }), 'and however the host is spelled').toBe(false);
    // The canonical spelling is unaffected, including the default that is used
    // when no url is given at all.
    expect(providerIsUsable({ provider: 'steel', url: 'https://api.steel.dev', apiKey: 'sk-test' })).toBe(true);
    expect(providerIsUsable({ provider: 'steel', apiKey: 'sk-test' }), 'the default is https').toBe(true);
    // ONLY the hosted endpoint. Plain http is exactly right for a self-hosted
    // Steel on a private network, and refusing it would break working
    // deployments to guard a service they are not talking to — the mirror
    // mistake this predicate has made before.
    expect(providerIsUsable({ provider: 'steel', url: 'http://steel.internal' }), 'self-hosted http is legitimate').toBe(true);
    expect(providerIsUsable({ provider: 'steel', url: 'http://steel.internal:8080', apiKey: 'sk-test' }), 'key or no key').toBe(true);
  });

  it('is not advertised for the hosted endpoint on a port that is not its own', () => {
    // `isHostedSteel` compares by host key and says nothing about the port, so
    // `https://api.steel.dev:80` is "hosted", is https, addresses the endpoint
    // and sits on a port `fetch` will happily open — and is a DIFFERENT ORIGIN
    // from the one the default names. The blocked-port check does not cover
    // this: 80 and 444 are legal to fetch, they simply are not where the hosted
    // API is, so the credential would go to whatever answers there.
    expect(providerIsUsable({ provider: 'steel', url: 'https://api.steel.dev:80', apiKey: 'sk-test' })).toBe(false);
    expect(providerIsUsable({ provider: 'steel', url: 'https://api.steel.dev:444', apiKey: 'sk-test' }), 'nor a near miss').toBe(false);
    expect(providerIsUsable({ provider: 'steel', url: 'https://api.steel.dev.:8443', apiKey: 'sk-test' }), 'however the host is spelled').toBe(false);
    // `:443` written out normalises to the empty port, so it is the canonical
    // endpoint and must still work — refusing it would be the mirror mistake.
    expect(providerIsUsable({ provider: 'steel', url: 'https://api.steel.dev:443', apiKey: 'sk-test' }), 'the default port spelled out').toBe(true);
    expect(providerIsUsable({ provider: 'steel', url: 'https://api.steel.dev', apiKey: 'sk-test' })).toBe(true);
    // Arbitrary ports stay right for a deployment somebody runs themselves.
    expect(providerIsUsable({ provider: 'steel', url: 'https://steel.internal:8443' }), 'self-hosted picks its own port').toBe(true);
    expect(providerIsUsable({ provider: 'steel', url: 'http://steel.internal:3000' })).toBe(true);
  });

  it('is not advertised for a credential that cannot be sent as a header', () => {
    // The env schema trims, which removes surrounding whitespace and nothing
    // else — so a key pasted out of a wrapped terminal or a here-doc can carry
    // an embedded newline. It is truthy, so the hosted gate read the deployment
    // as authenticated and `/api/config` advertised Browser mode; then `fetch`
    // refused the header before a byte went out.
    //
    // The third member of the category `fetch` refuses BEFORE sending, after
    // userinfo and blocked ports. Verified against Node's `Headers`, which is
    // the WHATWG validity check itself: CR, LF and NUL are rejected, and tab,
    // space, DEL and non-ASCII are not.
    expect(providerIsUsable({ provider: 'steel', apiKey: 'sk-a\nb' })).toBe(false);
    expect(providerIsUsable({ provider: 'steel', apiKey: 'sk-a\rb' }), 'a carriage return too').toBe(false);
    expect(providerIsUsable({ provider: 'steel', apiKey: 'sk-a\u0000b' }), 'and a NUL').toBe(false);
    // Checked wherever a key is present, not only for the hosted endpoint: a
    // self-hosted Steel behind a gateway takes a key too, and a malformed one
    // fails its first request just as hard.
    expect(providerIsUsable({ provider: 'steel', url: 'https://steel.internal', apiKey: 'sk-a\nb' })).toBe(false);
    // DEL, and every other C0 control. CONSTRUCTING a header accepts these —
    // `new Headers()` and `new Request()` both take `\x7f` — and the SEND path
    // does not, so the first version of this check asked the question next to
    // the one that mattered and advertised a key that dies as
    // `invalid steel-api-key header` before DNS.
    expect(providerIsUsable({ provider: 'steel', apiKey: 'sk-a\u007fb' }), 'DEL').toBe(false);
    expect(providerIsUsable({ provider: 'steel', apiKey: 'sk-a\u0001b' }), 'and the rest of C0').toBe(false);
    expect(providerIsUsable({ provider: 'steel', apiKey: 'sk-a\u001fb' })).toBe(false);
    // The whole refused set, probed against `fetch` itself rather than
    // described: 0x00-0x08, 0x0a-0x1f and 0x7f. Asserting it here means a
    // change to the rule has to change this list too.
    const refused: number[] = [];
    for (let i = 0; i <= 0xff; i++) {
      if (!providerIsUsable({ provider: 'steel', apiKey: `sk-a${String.fromCharCode(i)}b` })) refused.push(i);
    }
    expect(refused).toEqual([
      ...Array.from({ length: 9 }, (_, i) => i),
      ...Array.from({ length: 22 }, (_, i) => i + 10),
      0x7f,
    ]);
    // And a key with something merely UNUSUAL in it is still a key. Refusing
    // these would be the mirror mistake — a working deployment turned off to
    // guard against a character the runtime is perfectly happy to send.
    expect(providerIsUsable({ provider: 'steel', apiKey: 'sk-a\tb' }), 'a tab is a legal header value').toBe(true);
    expect(providerIsUsable({ provider: 'steel', apiKey: 'sk-\u00e9' }), 'nor is a high byte a problem').toBe(true);
    expect(providerIsUsable({ provider: 'steel', apiKey: 'sk-live-0123456789' })).toBe(true);
  });

  it('is advertised for a self-hosted steel with no credential', () => {
    // Only the hosted FALLBACK is refused. A Steel behind a private network or
    // its own gateway legitimately has no key, and demanding one for a URL the
    // operator supplied would break a working deployment to guard a default.
    expect(providerIsUsable({ provider: 'steel', url: 'https://steel.internal' })).toBe(true);
  });

  it('is not advertised for a steel base that is not an http(s) URL', () => {
    // The cdp branch grew endpoint validation and the steel branch did not, so
    // a malformed base passed the env schema, produced a usable-looking
    // provider, and failed at the first fetch — the inert control back again,
    // for the one provider the cdp fix did not cover.
    expect(providerIsUsable({ provider: 'steel', url: 'not a url' })).toBe(false);
    expect(providerIsUsable({ provider: 'steel', url: 'ws://api.steel.example' })).toBe(false);
    expect(providerIsUsable({ provider: 'steel', url: 'https://api.steel.example' })).toBe(true);
  });

  it('is not advertised where the operator configured nothing', () => {
    expect(providerIsUsable(undefined)).toBe(false);
  });
});

describe('every REMOTE_BROWSER_* value reaches the run config', () => {
  it('carries the credential and the session cap, not only the endpoint', () => {
    const env = loadEnv({
      ...baseEnv('/tmp'),
      REMOTE_BROWSER_PROVIDER: 'steel',
      REMOTE_BROWSER_URL: 'https://api.steel.example',
      REMOTE_BROWSER_API_KEY: 'sk-operator-key',
      REMOTE_BROWSER_MAX_SESSIONS: '4',
    });

    expect(buildCloudConfig([], 1, { ...remoteBrowserControls(env), browserMode: true }).tools?.remoteBrowser).toEqual({
      provider: 'steel',
      url: 'https://api.steel.example',
      apiKey: 'sk-operator-key',
      maxSessions: 4,
    });
  });

  it('omits what the operator did not set, rather than sending empty strings', () => {
    // A blank `url` reaching a provider is worse than an absent one: the CDP
    // adapter refuses an unparseable endpoint by name, while Steel would fall
    // back to its default API base only if the field is genuinely missing.
    const env = loadEnv({
      ...baseEnv('/tmp'),
      REMOTE_BROWSER_PROVIDER: 'steel',
    });

    expect(buildCloudConfig([], 1, { ...remoteBrowserControls(env), browserMode: true }).tools?.remoteBrowser).toEqual({
      provider: 'steel',
      maxSessions: 1,
    });
  });
});
