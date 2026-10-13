import { describe, it, expect, vi } from 'vitest';
import { WebFetchTool } from './web-fetch.js';
import type { ToolExecuteOptions } from '../types.js';
import type { EgressVerdict } from './policy/egress-policy.js';

function opts(checkEgress?: (url: string) => EgressVerdict): ToolExecuteOptions {
  return { tierId: 'T3', sessionId: 's1', requireApproval: false, checkEgress };
}

describe('web_fetch egress gate', () => {
  it('refuses before any network call when the gate denies', async () => {
    // If the gate is honoured the fetch never happens, so a global fetch spy
    // must stay untouched. (safeFetch uses the global fetch under the hood.)
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const tool = new WebFetchTool();
    const out = await tool.execute(
      { url: 'https://scan.example/1' },
      opts(() => ({ allow: false, code: 'host-spread', reason: 'too many hosts' })),
    );
    expect(out).toContain('Refused to fetch');
    expect(out).toContain('too many hosts');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('passes the exact URL to the gate', async () => {
    const seen: string[] = [];
    const tool = new WebFetchTool();
    await tool.execute(
      { url: 'https://a.example/path?q=1' },
      opts((u) => {
        seen.push(u);
        return { allow: false, code: 'denylist', reason: 'no' };
      }),
    );
    expect(seen).toEqual(['https://a.example/path?q=1']);
  });

  it('with no gate installed, falls through to the network path (local run)', async () => {
    // No checkEgress at all: the tool must reach the normal fetch path, which
    // for an unresolvable host fails on DNS — proof it was not stopped by the
    // policy gate, which never runs its DNS and would never say this.
    const tool = new WebFetchTool();
    const out = await tool.execute(
      { url: 'https://no-such-host.invalid/' },
      opts(undefined),
    );
    expect(out.toLowerCase()).toContain('could not resolve host');
  });
});
