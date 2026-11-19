import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink';
import { ActivityLog, commsLine, testSummary, toolNote, clock } from './activity.js';
import { CascadeView, flatten, focusOf, stepSelection } from './CascadeView.js';
import { getTheme } from '../../themes/index.js';
import type { TierNode } from '../components/AgentTree.js';
import type { PeerMessageEvent } from '../../../types.js';

const tree = (): TierNode => ({
  id: 'T1', role: 'T1', label: 'Build Copilot usage tracker', status: 'ACTIVE', children: [
    { id: 'T2-a', role: 'T2', label: 'Core storage & ingestion', status: 'COMPLETED', children: [
      { id: 'T3-a1', role: 'T3', label: 'Database schema', status: 'COMPLETED' },
      { id: 'T3-a2', role: 'T3', label: 'Copilot API client', status: 'COMPLETED' },
    ] },
    { id: 'T2-b', role: 'T2', label: 'Dashboard, CLI & verify', status: 'ACTIVE', children: [
      { id: 'T3-b1', role: 'T3', label: 'Web dashboard & REST API', status: 'ACTIVE' },
      { id: 'T3-b2', role: 'T3', label: 'CLI & verification', status: 'IDLE' },
    ] },
  ],
});

function activity(): ActivityLog {
  const a = new ActivityLog();
  const t0 = 1_000_000;
  a.status('T3-a1', 'ACTIVE', t0); a.status('T3-a1', 'COMPLETED', t0 + 41_000);
  a.status('T3-b1', 'ACTIVE', t0 + 50_000);
  a.think({ tierId: 'T3-b1', call: 1, text: 'Plan: routes first,' });
  a.think({ tierId: 'T3-b1', call: 1, text: ' then the templates.' });
  a.toolCall({ id: 'c1', tierId: 'T3-b1', toolName: 'file_write', input: { path: 'src/api.py', content: 'a\nb\nc' } });
  a.toolResult({ id: 'c1', tierId: 'T3-b1', toolName: 'file_write', output: 'Wrote src/api.py' });
  a.toolCall({ id: 'c2', tierId: 'T3-b1', toolName: 'shell', input: { command: 'pytest -q' } });
  a.toolResult({ id: 'c2', tierId: 'T3-b1', toolName: 'shell', output: '............\n12 passed in 0.4s' });
  a.toolCall({ id: 'c3', tierId: 'T3-b1', toolName: 'file_write', input: { path: 'templates/index.html' } });
  return a;
}

describe('activity', () => {
  it('records calls, results and the latest thought, per node', () => {
    const a = activity();
    const n = a.get('T3-b1')!;
    expect(n.thought).toBe('Plan: routes first, then the templates.');
    expect(n.items.map((i) => [i.tool, i.target, i.state, i.note])).toEqual([
      ['file_write', 'src/api.py', 'ok', '+3 −0'],
      ['shell', 'pytest -q', 'ok', '12 passed'],
      ['file_write', 'templates/index.html', 'running', undefined],
    ]);
    expect(a.get('T3-a1')!.endedAt! - a.get('T3-a1')!.startedAt!).toBe(41_000);
  });
  it('a failed command is marked failed, with its exit code', () => {
    const a = new ActivityLog();
    a.toolCall({ id: 'x', tierId: 'n', toolName: 'shell', input: { command: 'npm test' } });
    a.toolResult({ id: 'x', tierId: 'n', toolName: 'shell', output: 'Exit 1:\nboom' });
    expect(a.get('n')!.items[0]).toMatchObject({ state: 'failed', note: 'exit 1' });
  });
  it('reads test summaries and edits', () => {
    expect(testSummary('Tests  3 failed | 40 passed (43)')).toBe('3 failed, 40 passed');
    expect(testSummary('Ran 7 tests in 0.1s\n\nOK')).toBe('7 passed');
    expect(testSummary('hello')).toBeUndefined();
    expect(toolNote('file_edit', { old_string: 'a\nb', new_string: 'c' }, '')).toBe('+1 −2');
    expect(clock(72_000)).toBe('1:12');
  });
  it('says comms in plain words', () => {
    const ev = (syncType: PeerMessageEvent['syncType'], payload?: string, toId?: string): PeerMessageEvent => ({ fromId: 'T3-a1', ...(toId ? { toId } : {}), syncType, ...(payload ? { payload } : {}), timestamp: '', sessionId: 's' });
    const name = (id: string) => (id === 'T3-a1' ? 'T3·db' : 'T3·api');
    expect(commsLine(ev('COORDINATION', 'released src/db.py'), name)).toBe('T3·db released src/db.py');
    expect(commsLine(ev('SHARE_OUTPUT', 'schema ready', 'T3-b1'), name)).toBe('T3·db shared its result with T3·api: schema ready');
    expect(commsLine(ev('SIGNAL_READY'), name)).toBe('T3·db is ready');
  });
});

describe('the cascade view', () => {
  it('follows the deepest working node until one is picked, and ↑↓ moves the pick', () => {
    const root = tree();
    const a = activity();
    expect(focusOf(root, null, a).id).toBe('T3-b1');
    expect(stepSelection(root, null, a, -1)).toBe('T2-b');
    expect(stepSelection(root, 'T3-b2', a, 1)).toBe('T3-b2');
    expect(flatten(root).map((r) => r.prefix)).toEqual(['', '├─ ', '│  ├─ ', '│  └─ ', '└─ ', '   ├─ ', '   └─ ']);
  });

  const draw = (width: number) => {
    let frame = '';
    const stdout = Object.assign(new EventEmitter(), { columns: width, rows: 40, isTTY: true, write: (s: string) => { if (s.includes('T3')) frame = s; return true; } });
    const app = render(React.createElement(CascadeView, {
      root: tree(), activity: activity(), version: 1, selectedId: null, width, maxRows: width >= 110 ? 9 : 14, theme: getTheme('cascade'),
      peerEvents: [{ fromId: 'T3-a1', syncType: 'COORDINATION', payload: 'released src/db.py, models.py', timestamp: '', sessionId: 's' }],
      showComms: true, now: 1_000_000 + 122_000,
    }), { stdout: stdout as never, debug: true, patchConsole: false });
    app.unmount();
    const out = frame.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    return out;
  };

  it('wide: the tree, and beside it what the busiest node is doing', () => {
    const f = draw(140);
    const line = (needle: string) => f.split('\n').find((l) => l.includes(needle)) ?? '';
    expect(line('Build Copilot usage tracker')).toMatch(/████░░░░ 1\/2.*│ T3 · Web dashboard & REST API\s+1:12/);
    expect(f).toContain('│ ∙ Plan: routes first, then the templates.');
    expect(line('Database schema')).toMatch(/│  ├─ T3 ✔ Database schema\s+0:41/);
    expect(line('CLI & verification')).toContain('waiting');
    expect(f).toMatch(/▸ file_write\s+src\/api\.py\s+\+3 −0/);
    expect(f).toMatch(/▸ shell\s+pytest -q\s+12 passed/);
    expect(f).toMatch(/◐ file_write\s+templates\/index\.html/);
    expect(f).toContain('comms  T3·Database schema released src/db.py, models.py');
  });

  it('narrow: the same, with the detail under the tree', () => {
    const f = draw(80);
    const tree = f.indexOf('CLI & verification');
    const detail = f.indexOf('∙ Plan: routes first');
    expect(tree).toBeGreaterThan(-1);
    expect(detail).toBeGreaterThan(tree);
    for (const l of f.split('\n')) expect(l.length, l).toBeLessThanOrEqual(80);
  });
});
