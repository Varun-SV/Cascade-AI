import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_COMMANDS, ALLOWED_EVENTS, ALWAYS_DENIED, ALWAYS_DENIED_PREFIXES, HIDDEN_HISTORY_URL, POLICY_VERSION,
  agentUrl, checkCommand, filterEvent, filterReply, filterTargetInfo, parseFrame, policySchemaSnapshot,
} from './command-policy.js';
import { makeConsent } from './egress-rules.js';

const consent = makeConsent(['https://ok.test'], ['http://192.168.1.1']);
const ctx = { knownSessions: new Set(['tab', 'nested']) };
const cmd = (method: string, params = {}, ...session: (string | undefined)[]) => {
  const sessionId = session.length ? session[0] : 'tab';
  return { id: 1, method, params, ...(sessionId ? { sessionId } : {}) };
};

describe('P1: commands are default deny', () => {
  it('forwards every allowed method on a known session', () => {
    for (const m of ALLOWED_COMMANDS) {
      const params = m === 'Page.navigate' ? { url: 'https://ok.test/' } : m === 'Target.setAutoAttach' ? { flatten: true } : {};
      expect(checkCommand(cmd(m, params), ctx), m).toEqual({ forward: true });
      expect(checkCommand(cmd(m, params, 'nested'), ctx), m).toEqual({ forward: true });
    }
  });
  it('refuses every always-denied method, at the root and through a nested session', () => {
    for (const m of [...ALWAYS_DENIED, ...ALWAYS_DENIED_PREFIXES.map((p) => `${p}anything`)]) {
      for (const s of ['tab', 'nested', undefined]) expect(checkCommand(cmd(m, {}, s), ctx).forward, `${m} ${s}`).toBe(false);
    }
  });
  it('refuses the named emulation overrides, and an unlisted method', () => {
    for (const m of ['Emulation.setGeolocationOverride', 'Emulation.setUserAgentOverride', 'Page.brandNewMethod', 'Target.detachFromTarget']) {
      const d = checkCommand(cmd(m), ctx);
      expect(d).toMatchObject({ forward: false });
      expect(JSON.stringify(d)).toContain('not on the allowlist');
    }
  });
  it('refuses a fabricated session id, and an allowed method with no session', () => {
    expect(checkCommand(cmd('Runtime.evaluate', {}, 'made-up'), ctx).forward).toBe(false);
    expect(checkCommand(cmd('Runtime.evaluate', {}, undefined), ctx).forward).toBe(false);
  });
  it('checks the arguments that carry a destination', () => {
    for (const url of ['file:///etc/hostname', 'chrome://settings', 'javascript:alert(1)', 'data:text/html,x', '']) {
      expect(checkCommand(cmd('Page.navigate', { url }), ctx).forward, url).toBe(false);
    }
    expect(checkCommand(cmd('Page.navigate', { url: 'about:blank' }), ctx).forward).toBe(true);
    expect(checkCommand(cmd('Target.setAutoAttach', {}), ctx).forward).toBe(false);
  });
  it('no list overlaps: nothing allowed is also denied', () => {
    for (const m of ALLOWED_COMMANDS) {
      expect(ALWAYS_DENIED.has(m), m).toBe(false);
      expect(ALWAYS_DENIED_PREFIXES.some((p) => m.startsWith(p)), m).toBe(false);
    }
  });
});

describe('parseFrame', () => {
  it('accepts a well-formed command', () => {
    expect(parseFrame('{"id":1,"method":"Page.enable"}')).toEqual({ id: 1, method: 'Page.enable', params: {} });
  });
  it.each(['not json', '[]', 'null', '{"method":"x"}', '{"id":1.5,"method":"x"}', '{"id":1}', '{"id":1,"method":2}',
    '{"id":1,"method":"x","params":[]}', '{"id":1,"method":"x","params":null}', '{"id":1,"method":"x","sessionId":3}'])('refuses %s', (raw) => {
    expect(parseFrame(raw)).toBeNull();
  });
});

describe('the compatibility rule', () => {
  it('a list cannot change without a version bump', () => {
    const lists = JSON.stringify({
      commands: [...ALLOWED_COMMANDS].sort(), denied: [...ALWAYS_DENIED].sort(),
      prefixes: [...ALWAYS_DENIED_PREFIXES].sort(), events: policySchemaSnapshot(),
    });
    const digest = createHash('sha256').update(lists).digest('hex').slice(0, 16);
    // Change a list → bump POLICY_VERSION and update both values, in one reviewed commit.
    expect({ POLICY_VERSION, digest }).toEqual({ POLICY_VERSION: 2, digest: '40ac177c7c8f15e6' });
  });
});

describe('events are default deny at name, field and URL level', () => {
  it('drops an event that is not listed', () => {
    for (const m of ['Page.brandNewEvent', 'Network.requestWillBeSentExtraInfo', 'Network.responseReceivedExtraInfo',
      'Network.webSocketFrameReceived', 'Network.webSocketWillSendHandshakeRequest', 'Network.eventSourceMessageReceived',
      'Page.windowOpen', 'Log.entryAdded', 'Runtime.consoleAPICalled', 'Runtime.exceptionThrown',
      'Page.javascriptDialogOpening', 'Fetch.requestPaused', 'constructor', '__proto__']) {
      expect(filterEvent(m, { url: 'https://ok.test/' }, consent), m).toBeNull();
    }
  });
  it('removes a field that is not listed, at any depth', () => {
    const out = filterEvent('Page.frameAttached', { frameId: 'f', parentFrameId: 'p', stack: { secret: 1 }, future: 'x' }, consent);
    expect(out).toEqual({ frameId: 'f', parentFrameId: 'p' });
    const nested = filterEvent('Page.frameNavigated', { frame: { id: 'f', url: 'https://ok.test/', unreachableUrl: 'http://10.0.0.1/', future: 1 } }, consent);
    expect(nested).toEqual({ frame: { id: 'f', url: 'https://ok.test/' } });
  });
  it('keeps only allowlisted headers, and no body', () => {
    const out = filterEvent('Network.requestWillBeSent', {
      requestId: 'r', type: 'Fetch',
      initiator: { type: 'script', stack: { callFrames: [{ url: 'https://evil.test/' }] }, url: 'https://evil.test/' },
      request: {
        url: 'https://ok.test/a', method: 'POST', postData: 'BODY', postDataEntries: [{ bytes: 'BODY' }], hasPostData: true,
        headers: { Cookie: 'c=1', Authorization: 'x', 'X-Csrf': 'y', 'Content-Type': 'text/plain' },
      },
    }, consent);
    expect(out).toEqual({
      requestId: 'r', type: 'Fetch', initiator: { type: 'script' }, redirectHasExtraInfo: false,
      request: { url: 'https://ok.test/a', method: 'POST', hasPostData: true, headers: { 'Content-Type': 'text/plain' } },
    });
    const res = filterEvent('Network.responseReceived', {
      requestId: 'r', type: 'Fetch',
      response: { url: 'https://ok.test/a', status: 200, headersText: 'raw', remoteIPAddress: '1.2.3.4', securityDetails: {}, headers: { 'Set-Cookie': 'c=1', Location: 'https://evil.test' } },
    }, consent);
    expect(res).toEqual({ requestId: 'r', type: 'Fetch', hasExtraInfo: false, response: { url: 'https://ok.test/a', status: 200, statusText: '', headers: {} } });
  });
  it('applies the URL rule', () => {
    expect(agentUrl('https://u:p@ok.test/a?q=1#f', 'document', consent)).toBe('https://ok.test/a?q=1#f');
    expect(agentUrl('https://cdn.test/lib.js?token=SECRET#f', 'subresource', consent)).toBe('https://cdn.test/lib.js');
    expect(agentUrl('https://u:p@cdn.test/x', 'subresource', consent)).toBe('https://cdn.test/x');
    for (const blocked of ['http://127.0.0.1/x', 'http://[::1]/', 'http://localhost/', 'http://10.0.0.1/', 'file:///etc/passwd']) {
      expect(agentUrl(blocked, 'subresource', consent), blocked).toBeNull();
      expect(agentUrl(blocked, 'document', consent), blocked).toBeNull();
    }
    expect(agentUrl('https://offlist.test/', 'document', consent)).toBeNull();
    expect(agentUrl('http://192.168.1.1/admin', 'document', consent)).toBe('http://192.168.1.1/admin');
    expect(agentUrl(42, 'document', consent)).toBeNull();
  });
  it('drops the whole event when a URL in it is blocked', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['Page.frameRequestedNavigation', { frameId: 'f', url: 'https://offlist.test/?m=SECRET' }],
      ['Page.frameScheduledNavigation', { frameId: 'f', url: 'http://10.0.0.1/' }],
      ['Page.frameStartedNavigating', { frameId: 'f', url: 'https://offlist.test/' }],
      ['Page.frameNavigated', { frame: { id: 'f', url: 'https://offlist.test/' } }],
      ['Network.webSocketCreated', { requestId: 'r', url: 'ws://127.0.0.1:9/' }],
      ['Network.requestWillBeSent', { requestId: 'r', type: 'Document', request: { url: 'https://offlist.test/' } }],
      ['Network.requestWillBeSent', { requestId: 'r', type: 'Fetch', request: { url: 'http://127.0.0.1:9/' } }],
      ['Network.responseReceived', { requestId: 'r', type: 'Document', response: { url: 'https://offlist.test/' } }],
      ['Target.attachedToTarget', { sessionId: 's', targetInfo: { targetId: 't', url: 'https://offlist.test/' } }],
      ['Runtime.executionContextCreated', { context: { id: 1, origin: 'https://offlist.test' } }],
    ];
    for (const [m, p] of cases) expect(filterEvent(m, p, consent), m).toBeNull();
  });
});

describe('page-controlled text stays out', () => {
  it('removes fragments, frame names, titles and free-form auxData', () => {
    const nav = filterEvent('Page.frameNavigated', { frame: { id: 'f', url: 'https://ok.test/', urlFragment: '#SECRET', name: 'SECRET', domainAndRegistry: 'x' } }, consent);
    expect(nav).toEqual({ frame: { id: 'f', url: 'https://ok.test/' } });
    const t = filterEvent('Target.targetInfoChanged', { targetInfo: { targetId: 't', url: 'https://ok.test/', title: 'SECRET' } }, consent);
    expect(t).toEqual({ targetInfo: { targetId: 't', url: 'https://ok.test/' } });
    const ctx = filterEvent('Runtime.executionContextCreated', { context: { id: 1, origin: 'https://ok.test', auxData: { isDefault: true, type: 'default', frameId: 'f', nested: { url: 'https://offlist.test/SECRET' }, future: 'SECRET' } } }, consent);
    expect(JSON.stringify(ctx)).not.toContain('SECRET');
    expect(ctx).toMatchObject({ context: { auxData: { isDefault: true, type: 'default', frameId: 'f' } } });
    expect(filterEvent('Network.responseReceived', { requestId: 'r', response: { url: 'https://ok.test/', status: 200, statusText: 'SECRET' } }, consent)).toMatchObject({ response: { statusText: '' } });
  });
  it('filters target info in replies too', () => {
    expect(filterTargetInfo({ targetId: 't', url: 'https://ok.test/', title: 'SECRET', canAccessOpener: false }, consent)).toEqual({ targetId: 't', url: 'https://ok.test/' });
    expect(filterTargetInfo({ targetId: 't', url: 'https://offlist.test/' }, consent)).toBeNull();
  });
});

describe('nothing promises what the filter drops', () => {
  it('clears the ExtraInfo flags even when the browser sets them', () => {
    expect(filterEvent('Network.responseReceived', { requestId: 'r', hasExtraInfo: true, response: { url: 'https://ok.test/' } }, consent)).toMatchObject({ hasExtraInfo: false });
    expect(filterEvent('Network.requestWillBeSent', { requestId: 'r', redirectHasExtraInfo: true, request: { url: 'https://ok.test/' } }, consent)).toMatchObject({ redirectHasExtraInfo: false });
  });
});

describe('replies that carry URLs', () => {
  it('removes frames on a site without consent from the frame tree', () => {
    const out = filterReply('Page.getFrameTree', {
      frameTree: {
        frame: { id: 'a', url: 'https://ok.test/', unreachableUrl: 'http://10.0.0.1/' },
        childFrames: [{ frame: { id: 'b', url: 'https://offlist.test/' } }, { frame: { id: 'c', url: 'https://ok.test/f' } }],
      },
    }, consent);
    expect(out).toEqual({ frameTree: { frame: { id: 'a', url: 'https://ok.test/' }, childFrames: [{ frame: { id: 'c', url: 'https://ok.test/f' } }] } });
  });
  it('hides history entries on a site without consent', () => {
    const out = filterReply('Page.getNavigationHistory', {
      currentIndex: 1,
      entries: [{ id: 1, url: 'https://offlist.test/?m=SECRET', title: 'SECRET' }, { id: 2, url: 'https://ok.test/', title: 'ok' }],
    }, consent);
    expect(JSON.stringify(out)).not.toContain('SECRET');
    expect((out.entries as { url: string }[]).map((e) => e.url)).toEqual([HIDDEN_HISTORY_URL, 'https://ok.test/']);
  });
  it('leaves other replies alone', () => {
    expect(filterReply('Runtime.evaluate', { result: { value: 1 } }, consent)).toEqual({ result: { value: 1 } });
  });
});
