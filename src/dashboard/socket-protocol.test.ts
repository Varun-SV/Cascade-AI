import { describe, expect, it } from 'vitest';
import {
  normalizePermissionDecisionPayload,
  normalizeRuntimeRefreshPayload,
  normalizeSessionSubscriptionPayload,
} from './socket-protocol.js';

describe('dashboard socket protocol helpers', () => {
  it('normalizes legacy and typed runtime refresh payloads to the shared shape', () => {
    expect(normalizeRuntimeRefreshPayload()).toEqual({ scope: 'workspace' });
    expect(normalizeRuntimeRefreshPayload('global')).toEqual({ scope: 'global' });
    expect(normalizeRuntimeRefreshPayload({ scope: 'workspace' })).toEqual({ scope: 'workspace' });
  });

  it('normalizes session subscription payloads from both string and object callers', () => {
    expect(normalizeSessionSubscriptionPayload('session-1')).toEqual({ sessionId: 'session-1' });
    expect(normalizeSessionSubscriptionPayload({ sessionId: 'session-2' })).toEqual({ sessionId: 'session-2' });
  });

  it('normalizes approval decisions to the shared permission decision payload', () => {
    expect(normalizePermissionDecisionPayload({
      id: 'req-1',
      approved: true,
      always: true,
    })).toEqual({
      requestId: 'req-1',
      approved: true,
      always: true,
      decidedBy: 'USER',
    });
  });
});

describe('the config:current snapshot is the shared, complete one', () => {
  // This began as a check that the socket snapshot carried `endpoints` at all,
  // asserted against an inline projection in the handler. That projection is
  // gone: the panel keeps its own defaults for whatever a snapshot omits and
  // re-serializes them on the next save, so once the save applied the whole
  // payload a partial snapshot could delete Azure deployments and reset
  // advanced knobs. `settingsSnapshot()` is now the one builder, tested for
  // completeness in `config/settings-payload.test.ts`; what is left to check
  // here is that this handler actually calls it.
  it('emits the shared builder rather than a local projection', async () => {
    const fs = await import('node:fs/promises');
    const url = await import('node:url');
    const nodePath = await import('node:path');
    const here = nodePath.dirname(url.fileURLToPath(import.meta.url));
    const source = await fs.readFile(nodePath.join(here, 'server.ts'), 'utf-8');

    expect(source).toMatch(/'config:current', settingsSnapshot\(this\.config\)/);
    // No second projection beside it — that is what diverged.
    expect(source).not.toMatch(/endpoints: Object\.fromEntries\(/);
    // …and the save acknowledgement returns one too, so the panel re-hydrates
    // from what was stored rather than from what it sent.
    expect(source).toMatch(/snapshot: settingsSnapshot\(this\.config\)/);
  });
});

describe('the save acknowledgement means durable, not merely handled', () => {
  // `persistConfig()` swallowed every filesystem error and the handler ACKed
  // success regardless, so a read-only config path produced: live object
  // mutated, disk write failed, panel cleared the typed keys and showed
  // "Saved", and the changes vanished at the next restart.
  it('reports a failed disk write in the acknowledgement', async () => {
    const fs = await import('node:fs/promises');
    const url = await import('node:url');
    const nodePath = await import('node:path');
    const here = nodePath.dirname(url.fileURLToPath(import.meta.url));
    const source = await fs.readFile(nodePath.join(here, 'server.ts'), 'utf-8');

    // persistConfig reports its outcome rather than returning void, and gets it
    // from the helper whose failure path `write-config.test.ts` exercises for
    // real rather than by inspection.
    expect(source).toMatch(/private persistConfig\(\): \{ ok: true \} \| \{ ok: false; error: string \}/);
    expect(source).toMatch(/const result = writeConfigFile\(/);
    expect(source).toMatch(/return result;/);
    // …and the handler puts it in the ack.
    expect(source).toMatch(/const persisted = this\.persistConfig\(\)/);
    expect(source).toMatch(/persisted\.ok \? \{\} : \{ error:/);
  });

  it('keeps the global-credential sync best-effort, which it genuinely is', async () => {
    const fs = await import('node:fs/promises');
    const url = await import('node:url');
    const nodePath = await import('node:path');
    const here = nodePath.dirname(url.fileURLToPath(import.meta.url));
    const source = await fs.readFile(nodePath.join(here, 'server.ts'), 'utf-8');
    // Failing the convenience copy does not lose what the user just typed, so
    // it must not fail the save.
    expect(source).toMatch(/Failed to sync global credentials/);
  });
});
