// ─────────────────────────────────────────────
//  Cascade Desktop — both Settings writers reach the browser module
// ─────────────────────────────────────────────
//
//  There are TWO independent settings writers:
//
//    - `ipcMain.handle('cascade:updateSettings')` in main.ts — the route the
//      desktop Settings panel tries FIRST.
//    - DashboardServer's socket `config:update` handler.
//
//  Both call the same `commitSettings`, so the persisted config agrees either
//  way. What does not agree on its own is anything DERIVED from that config and
//  pushed into the browser module, because that push is written at the call
//  site — and a gate wired into one writer does nothing at all on the other.
//
//  This has happened twice. First `agentBrowserControl`, mirrored on the IPC
//  path only, so a socket write left the module enforcing a stale flag. Then,
//  in the change that fixed exactly that, the approval-wait ceiling went in on
//  the socket hook only — leaving the panel's primary route stale instead.
//
//  So the guard is structural: every derived gate goes through one helper, and
//  no writer may call the setters directly. A behavioural test cannot cover
//  this — main.ts wires Electron at import time and has no harness — but the
//  drift is a shape, and the shape is checkable.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// browser.ts imports electron, which has no real binary in CI. The derivation
// under test touches none of it; this only keeps the import graph loadable.
vi.mock('electron', () => ({
  ipcMain: { handle: () => {} },
  shell: { openExternal: () => {} },
  session: { fromPartition: () => ({ setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {} }) },
  WebContentsView: class {},
}));

const { approvalWaitCeilingFor } = await import('./browser.js');

const mainSource = readFileSync(join(__dirname, 'main.ts'), 'utf8');

/** Occurrences of a call, ignoring the import statement that names it. */
function callSites(source: string, fn: string): number {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('import'))
    .filter((line) => line.includes(`${fn}(`))
    .length;
}

describe('the approval-wait ceiling derivation', () => {
  it('leaves the approval room to time out first', () => {
    // The margin is the point: whichever fires first decides what the user is
    // told, and the approval timeout can explain itself where a browser action
    // cut short by its ceiling just fails.
    expect(approvalWaitCeilingFor(600_000)).toBeGreaterThan(600_000);
    expect(approvalWaitCeilingFor(1_800_000)).toBeGreaterThan(1_800_000);
  });

  it('assumes the escalator default when the setting is absent', () => {
    expect(approvalWaitCeilingFor(undefined)).toBeGreaterThan(600_000);
  });

  it('tracks the configured window rather than a fixed number', () => {
    // The defect this replaced: a constant 120s ceiling against a 600s approval
    // window, so an action the user had already approved was killed while they
    // were still reading the next prompt.
    expect(approvalWaitCeilingFor(1_800_000)).toBeGreaterThan(approvalWaitCeilingFor(600_000));
  });
});

describe('neither Settings writer can drift from the browser module', () => {
  it('routes every derived gate through one helper', () => {
    // Exactly one call site each, inside syncBrowserGates. A writer that pushes
    // a gate itself — which is how both drifts happened — makes this fail.
    expect(callSites(mainSource, 'setAgentControlEnabled'), 'only syncBrowserGates may set this').toBe(1);
    expect(callSites(mainSource, 'setApprovalWaitCeiling'), 'only syncBrowserGates may set this').toBe(1);
  });

  it('calls that helper from the IPC writer, which is the panel\'s primary route', () => {
    // The half that was missed last time. Settings tries this path first, so a
    // gate wired only into the socket fallback is stale on the normal route.
    const handler = mainSource.slice(mainSource.indexOf("ipcMain.handle('cascade:updateSettings'"));
    const afterCommit = handler.slice(handler.indexOf('commitSettings('));
    expect(afterCommit).toContain('syncBrowserGates(');
  });

  it('calls that helper from the socket writer too', () => {
    const hook = mainSource.slice(mainSource.indexOf('onSettingsChanged'));
    expect(hook.slice(0, 400)).toContain('syncBrowserGates(');
  });

  it('applies the gates once at startup, so a fresh backend is not stale either', () => {
    expect(callSites(mainSource, 'syncBrowserGates')).toBeGreaterThanOrEqual(3);
  });
});
