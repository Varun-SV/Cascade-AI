// ─────────────────────────────────────────────
//  Cascade AI — Provider-safe tool names
// ─────────────────────────────────────────────
//
//  From a real 400 with the GitHub connector enabled and Azure gpt-5.4-mini
//  selected:
//
//    Invalid 'tools[2].function.name': string does not match pattern
//    '^[a-zA-Z0-9_-]+$'
//
//  Tool index 2 was an MCP tool named `mcp::github::get_me`. The colons are
//  illegal, and OpenAI/Azure reject the entire request rather than the one
//  tool — so every message failed, whatever it asked for.

import { describe, expect, it } from 'vitest';
import {
  MCP_TOOL_PREFIX,
  MAX_MCP_TOOL_NAME_LENGTH,
  assignMcpToolNames,
  disambiguateMcpServerNames,
  isMcpToolName,
  isProviderSafeToolName,
  mcpServerPrefix,
  mcpToolName,
  removeMcpServerDenials,
  sanitizeToolNameSegment,
  uniqueMcpServerName,
} from './tool-name.js';
import { ToolRegistry } from './registry.js';

describe('provider-safe tool names', () => {
  it('produces a legal name for the case that was failing', () => {
    const name = mcpToolName('github', 'get_me');
    expect(name).toBe('mcp__github__get_me');
    expect(isProviderSafeToolName(name)).toBe(true);
    // The exact character that broke it.
    expect(name).not.toContain(':');
  });

  it('folds every illegal character a server or tool name might carry', () => {
    for (const [raw, expected] of [
      ['My Server', 'My_Server'],
      ['api.githubcopilot.com', 'api_githubcopilot_com'],
      ['server/with/slashes', 'server_with_slashes'],
      ['emoji🎉name', 'emoji_name'],
      ['trailing__', 'trailing'],
      ['__leading', 'leading'],
    ] as const) {
      expect(sanitizeToolNameSegment(raw)).toBe(expected);
    }
  });

  it('collapses runs so two different-looking names do not become identical-but-distinct', () => {
    // "My  Server" and "My!@#Server" both mean one separator, not three.
    expect(sanitizeToolNameSegment('My  Server')).toBe(sanitizeToolNameSegment('My!@#Server'));
  });

  it('trims separators in linear time, whatever the input shape', () => {
    // The trim used to be /^_+|_+$/g, which backtracks quadratically on an
    // interior run: `_+$` is retried from every position and fails the anchor
    // each time. Tool names come off a remote MCP server, so the shape is not
    // ours to guarantee even where the collapse above happens to prevent it.
    const nasty = `a${'_'.repeat(60_000)}b`;
    const started = Date.now();
    expect(sanitizeToolNameSegment(nasty)).toBe('a_b');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('never yields an empty segment', () => {
    // A zero-length segment would make the assembled name ambiguous.
    expect(sanitizeToolNameSegment('')).toBe('_');
    expect(sanitizeToolNameSegment('!!!')).toBe('_');
    expect(isProviderSafeToolName(mcpToolName('', ''))).toBe(true);
  });

  it('keeps the prefix and per-server filtering working', () => {
    const name = mcpToolName('My Server', 'do_thing');
    expect(isMcpToolName(name)).toBe(true);
    expect(name.startsWith(mcpServerPrefix('My Server'))).toBe(true);
    // A different server must not match.
    expect(name.startsWith(mcpServerPrefix('Other'))).toBe(false);
    expect(MCP_TOOL_PREFIX).toBe('mcp__');
  });

  it('rejects the old format, so a regression is caught rather than shipped', () => {
    expect(isProviderSafeToolName('mcp::github::get_me')).toBe(false);
    expect(isProviderSafeToolName('has space')).toBe(false);
    expect(isProviderSafeToolName('has.dot')).toBe(false);
    expect(isProviderSafeToolName('')).toBe(false);
    // The forms that must stay legal.
    expect(isProviderSafeToolName('web_search')).toBe(true);
    expect(isProviderSafeToolName('mcp__github__get_me')).toBe(true);
    expect(isProviderSafeToolName('some-tool-1')).toBe(true);
  });
});

describe('the whole built-in tool surface is provider-safe', () => {
  it('every registered tool name matches the strictest provider alphabet', () => {
    // The property that actually prevents a repeat: not "the MCP names are
    // fixed" but "no tool Cascade registers can have an illegal name". A new
    // built-in with a colon or a space now fails here instead of 400ing every
    // request for anyone on OpenAI or Azure.
    const registry = new ToolRegistry({ allowedTools: [] } as never, process.cwd());
    const names = registry.getToolDefinitions().map((d) => d.name);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(isProviderSafeToolName(name), `tool "${name}" would be rejected by OpenAI/Azure`).toBe(true);
    }
  });
});

// Sanitising is lossy on purpose, so two raw names can land on one string.
// Harmless as display, fatal as identity: ToolRegistry keys by name, so the
// second wrapper silently replaces the first and one checkbox controls two
// tools — or denies a tool the user never touched.
describe('assignMcpToolNames', () => {
  it('leaves non-colliding names exactly as mcpToolName builds them', () => {
    const names = assignMcpToolNames([
      { server: 'github', tool: 'get_me' },
      { server: 'github', tool: 'list_repos' },
    ]);
    expect(names).toEqual([mcpToolName('github', 'get_me'), mcpToolName('github', 'list_repos')]);
  });

  it('suffixes tools whose raw names sanitize onto one already taken', () => {
    // None of the three is a clean (already-legal) raw name, so the tie breaks
    // lexicographically: a space (0x20) sorts before '/' (0x2F) sorts before
    // '@' (0x40).
    const names = assignMcpToolNames([
      { server: 'srv', tool: 'list@files' },
      { server: 'srv', tool: 'list files' },
      { server: 'srv', tool: 'list/files' },
    ]);
    expect(names).toEqual(['mcp__srv__list_files_3', 'mcp__srv__list_files', 'mcp__srv__list_files_2']);
  });

  it('gives the clean (already-legal) raw identity the unsuffixed name', () => {
    // A raw name that needs no folding is the stable anchor: it can never be
    // displaced by one the vendor adds later that happens to fold onto it.
    const names = assignMcpToolNames([
      { server: 'srv', tool: 'list@files' },
      { server: 'srv', tool: 'list_files' }, // already legal — wins regardless of position
    ]);
    expect(names).toEqual(['mcp__srv__list_files_2', 'mcp__srv__list_files']);
  });

  it('does not depend on array order — same set, different order, same result', () => {
    // MCP's tools/list makes no ordering promise, and these names are
    // persisted (a saved deny list). An order-dependent scheme would let the
    // unsuffixed key silently move to a different tool between two discovery
    // runs, moving the user's denial with it.
    const a = [{ server: 'srv', tool: 'list files' }, { server: 'srv', tool: 'list@files' }];
    const b = [{ server: 'srv', tool: 'list@files' }, { server: 'srv', tool: 'list files' }];
    const namesA = assignMcpToolNames(a);
    const namesB = assignMcpToolNames(b);
    // Look up each raw tool's assigned name regardless of position.
    const byTool = (tools: typeof a, names: string[]) =>
      Object.fromEntries(tools.map((t, i) => [t.tool, names[i]]));
    expect(byTool(a, namesA)).toEqual(byTool(b, namesB));
  });

  it('separates servers whose names fold together', () => {
    const names = assignMcpToolNames([
      { server: 'my server', tool: 'run' },  // folds to my_server
      { server: 'my-server', tool: 'run' },  // already legal — distinct base, no collision
      { server: 'my@server', tool: 'run' },  // also folds to my_server — collides with the first
    ]);
    expect(names[1]).toBe('mcp__my-server__run'); // untouched — distinct prefix
    const pair = [names[0], names[2]].sort();
    expect(pair).toEqual(['mcp__my_server__run', 'mcp__my_server__run_2']);
  });

  it('keeps every issued name provider-safe', () => {
    const names = assignMcpToolNames(
      ['a b', 'a@b', 'a/b', 'a.b'].map((tool) => ({ server: 'srv', tool })),
    );
    for (const n of names) expect(isProviderSafeToolName(n)).toBe(true);
  });

  it('is independent per call, so one batch cannot leak into the next', () => {
    expect(assignMcpToolNames([{ server: 'srv', tool: 'x' }])).toEqual(['mcp__srv__x']);
    expect(assignMcpToolNames([{ server: 'srv', tool: 'x' }])).toEqual(['mcp__srv__x']);
  });
});

describe('uniqueMcpServerName', () => {
  it('leaves a non-colliding name untouched', () => {
    expect(uniqueMcpServerName('github', ['notion', 'slack'])).toBe('github');
  });

  it('suffixes when the sanitized PREFIX collides, even if the raw name differs', () => {
    // `foo bar` and `foo@bar` are different strings but both register as
    // mcp__foo_bar__… — comparing raw names would miss this collision.
    expect(uniqueMcpServerName('foo@bar', ['foo bar'])).toBe('foo@bar (2)');
  });

  it('is a no-op when only the raw name matches — connectOAuth updates in place instead', () => {
    // Callers check `servers.findIndex(s => s.name === name)` before reaching
    // this function specifically so a re-connect of the SAME server updates in
    // place rather than being treated as a new, colliding one.
    expect(uniqueMcpServerName('github', ['other'])).toBe('github');
  });

  it('keeps counting up past a taken suffix', () => {
    expect(uniqueMcpServerName('foo bar', ['foo bar', 'foo bar (2)'])).toBe('foo bar (3)');
  });
});

describe('disambiguateMcpServerNames', () => {
  it('is a true no-op — same reference, empty renames — when nothing collides', () => {
    const servers = [{ name: 'github' }, { name: 'notion' }];
    const { servers: result, renames } = disambiguateMcpServerNames(servers);
    expect(result).toBe(servers);
    expect(renames).toEqual([]);
  });

  it('keeps the FIRST entry of a colliding group untouched', () => {
    // The first connection is presumably already working; renaming it would
    // move its stored deny-list entries and its OAuth token path out from
    // under it for no reason.
    const servers = [{ name: 'foo bar', url: 'a' }, { name: 'foo@bar', url: 'b' }];
    const { servers: result } = disambiguateMcpServerNames(servers);
    expect(result[0]!.name).toBe('foo bar');
    expect(result[1]!.name).not.toBe('foo@bar');
  });

  it('produces distinct sanitized prefixes for every entry', () => {
    const servers = [{ name: 'foo bar' }, { name: 'foo@bar' }, { name: 'foo/bar' }];
    const { servers: result } = disambiguateMcpServerNames(servers);
    const prefixes = new Set(result.map((s) => mcpServerPrefix(s.name)));
    expect(prefixes.size).toBe(3);
  });

  it('preserves other fields on a renamed entry', () => {
    const servers = [
      { name: 'foo bar', url: 'https://a.example.com', oauthStore: '/x/a.json' },
      { name: 'foo@bar', url: 'https://b.example.com', oauthStore: '/x/b.json' },
    ];
    const { servers: result } = disambiguateMcpServerNames(servers);
    expect(result[1]).toMatchObject({ url: 'https://b.example.com', oauthStore: '/x/b.json' });
  });

  it('reports every rename made, so a caller can follow it into other config fields', () => {
    // ConfigManager uses this to keep tools.mcpTrusted and tools.disabledTools
    // in sync — this function only owns mcpServers, so it hands back what
    // changed rather than reaching into fields it doesn't know about.
    const servers = [{ name: 'foo bar' }, { name: 'foo@bar' }, { name: 'notion' }];
    const { renames } = disambiguateMcpServerNames(servers);
    expect(renames).toHaveLength(1);
    expect(renames[0]!.from).toBe('foo@bar');
    expect(renames[0]!.to).not.toBe('foo@bar');
  });
});

describe('removeMcpServerDenials', () => {
  it('drops only the removed server\'s entries', () => {
    const denials = ['mcp__github__delete_repo', 'mcp__notion__delete_page'];
    expect(removeMcpServerDenials(denials, 'github')).toEqual(['mcp__notion__delete_page']);
  });

  it('is a true no-op — same reference — when the server had no denials', () => {
    const denials = ['mcp__notion__delete_page'];
    expect(removeMcpServerDenials(denials, 'github')).toBe(denials);
  });

  it('passes undefined through unchanged', () => {
    expect(removeMcpServerDenials(undefined, 'github')).toBeUndefined();
  });

  it('matches by sanitized PREFIX, so a raw-name variant is still found', () => {
    // Reconnecting under a punctuation-different raw name that folds to the
    // same prefix must still find and drop the old denials — otherwise a
    // remove+reconnect cycle through a slightly different raw name would leak
    // stale denials forever.
    const denials = ['mcp__foo_bar__delete_everything'];
    expect(removeMcpServerDenials(denials, 'foo@bar')).toEqual([]);
  });
});

describe('mcpToolName / mcpServerPrefix — bounded length', () => {
  it('never exceeds the provider limit, even for long server and tool names', () => {
    // Cloud accepts connector names up to 80 characters — well past what
    // OpenAI/Azure's 64-char function.name budget can hold once the tool
    // name is appended. Sanitizing alone (folding the alphabet) says nothing
    // about length.
    const longServer = 'a'.repeat(80);
    const longTool = 'b'.repeat(80);
    const name = mcpToolName(longServer, longTool);
    expect(name.length).toBeLessThanOrEqual(MAX_MCP_TOOL_NAME_LENGTH);
    expect(isProviderSafeToolName(name)).toBe(true);
  });

  it('mcpServerPrefix alone stays within budget for a long connector name', () => {
    const prefix = mcpServerPrefix('c'.repeat(80));
    expect(prefix.length).toBeLessThanOrEqual(MAX_MCP_TOOL_NAME_LENGTH);
  });

  it('leaves a short name byte-identical to the unbounded encoding', () => {
    // No behavior change for the overwhelmingly common case.
    expect(mcpToolName('github', 'get_me')).toBe('mcp__github__get_me');
  });

  it('is deterministic and collision-resistant for two long names sharing a prefix', () => {
    // A naive slice would make these collide — both share their first 24
    // characters. The hash tail has to differ, or ToolRegistry (keyed by
    // name) silently keeps only one wrapper.
    const a = mcpToolName('srv', `${'x'.repeat(40)}-alpha`);
    const b = mcpToolName('srv', `${'x'.repeat(40)}-beta`);
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(MAX_MCP_TOOL_NAME_LENGTH);
    expect(b.length).toBeLessThanOrEqual(MAX_MCP_TOOL_NAME_LENGTH);
  });

  it('is stable across calls — the same input always produces the same truncated name', () => {
    const long = 'z'.repeat(90);
    expect(mcpToolName('srv', long)).toBe(mcpToolName('srv', long));
  });

  it('leaves headroom for a collision suffix from assignMcpToolNames', () => {
    const name = mcpToolName('a'.repeat(80), 'b'.repeat(80));
    expect(`${name}_999`.length).toBeLessThanOrEqual(MAX_MCP_TOOL_NAME_LENGTH);
  });
});

describe('assignMcpToolNames — suffix must not collide with an existing base', () => {
  it('never re-derives a name that is already someone else\'s base, in a 3-way case', () => {
    // foo bar / foo@bar collide and would naturally suffix the loser to
    // "..._2" — but a THIRD, distinct tool "foo bar 2" on the same server
    // already owns that exact string as its own (non-colliding) base.
    const names = assignMcpToolNames([
      { server: 'srv', tool: 'foo bar' },
      { server: 'srv', tool: 'foo@bar' },
      { server: 'srv', tool: 'foo bar 2' },
    ]);
    expect(new Set(names).size).toBe(3); // all three distinct
    expect(names[2]).toBe('mcp__srv__foo_bar_2'); // the singleton's own base, untouched
    expect(names.filter((n) => n === 'mcp__srv__foo_bar_2')).toHaveLength(1); // not shared
  });

  it('skips past a whole chain of pre-taken suffixes', () => {
    const names = assignMcpToolNames([
      { server: 'srv', tool: 'foo bar' },   // collides with foo@bar
      { server: 'srv', tool: 'foo@bar' },   // → would want "_2"
      { server: 'srv', tool: 'foo_bar_2' }, // already owns "_2"
      { server: 'srv', tool: 'foo_bar_3' }, // already owns "_3" too
    ]);
    expect(new Set(names).size).toBe(4);
  });
});
