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
  isMcpToolName,
  isProviderSafeToolName,
  mcpServerPrefix,
  mcpToolName,
  sanitizeToolNameSegment,
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
