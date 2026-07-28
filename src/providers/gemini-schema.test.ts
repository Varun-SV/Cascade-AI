// ─────────────────────────────────────────────
//  Cascade AI — Gemini tool-schema sanitisation
// ─────────────────────────────────────────────
//
//  The cases below are taken from a real 400 seen in the desktop app with the
//  GitHub MCP connector enabled and Gemini selected. Every prompt failed —
//  including one that had nothing to do with tools — because the request was
//  rejected on the tool envelope before the model ever saw the message.

import { describe, expect, it } from 'vitest';
import { sanitizeGeminiSchema, toGeminiParameters } from './gemini-schema.js';

describe('gemini schema sanitisation', () => {
  it('drops the x-mcp-header extension that hard-blocked every Gemini request', () => {
    // Verbatim shape from the GitHub MCP server's tool definitions.
    const mcpSchema = {
      type: 'object',
      properties: {
        owner: { description: 'Repository owner', type: 'string', 'x-mcp-header': 'owner' },
        repo: { description: 'Repository name', type: 'string', 'x-mcp-header': 'repo' },
        pullNumber: { description: 'Pull request number', type: 'number' },
      },
      required: ['owner', 'repo'],
    };

    const out = sanitizeGeminiSchema(mcpSchema)!;
    const props = out['properties'] as Record<string, Record<string, unknown>>;
    expect(props['owner']).toEqual({ description: 'Repository owner', type: 'string' });
    expect(props['owner']).not.toHaveProperty('x-mcp-header');
    expect(props['repo']).not.toHaveProperty('x-mcp-header');
    // The parts Gemini needs survive intact.
    expect(out['required']).toEqual(['owner', 'repo']);
    expect(props['pullNumber']!['type']).toBe('number');
  });

  it('stringifies a non-string enum rather than dropping the constraint', () => {
    // "Invalid value at '…value.enum[0]' (TYPE_STRING), true" — the second
    // failure in the same response. Dropping the enum would silently widen the
    // parameter to anything, which is worse than a lossy representation.
    const out = sanitizeGeminiSchema({
      type: 'object',
      properties: { flag: { type: 'boolean', enum: [true, false] } },
    })!;
    const flag = (out['properties'] as Record<string, Record<string, unknown>>)['flag']!;
    expect(flag['enum']).toEqual(['true', 'false']);
  });

  it('strips every unknown key, not just the ones already seen', () => {
    // Allowlist, not blocklist: the next extension nobody has met yet is
    // dropped without another round of 400s.
    const out = sanitizeGeminiSchema({
      type: 'string',
      description: 'kept',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      additionalProperties: false,
      const: 'x',
      exclusiveMinimum: 3,
      'x-anything-at-all': true,
    })!;
    expect(out).toEqual({ type: 'string', description: 'kept' });
  });

  it('recurses through nested objects and arrays', () => {
    const out = sanitizeGeminiSchema({
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string', 'x-mcp-header': 'n' } },
          },
        },
      },
    })!;
    const arr = (out['properties'] as Record<string, Record<string, unknown>>)['items']!;
    const inner = (arr['items'] as Record<string, unknown>)['properties'] as Record<string, unknown>;
    expect(inner['name']).toEqual({ type: 'string' });
  });

  it('converts a nullable union type into Gemini\'s single type + nullable', () => {
    const out = sanitizeGeminiSchema({ type: ['string', 'null'], description: 'maybe' })!;
    expect(out).toEqual({ type: 'string', nullable: true, description: 'maybe' });
  });

  it('infers the object type when properties are present but type is not', () => {
    // Gemini infers nothing and rejects a typeless node that has properties.
    const out = sanitizeGeminiSchema({ properties: { a: { type: 'string' } } })!;
    expect(out['type']).toBe('object');
  });

  it('keeps a property that sanitises to nothing, so `required` stays valid', () => {
    // A $ref-only property would otherwise vanish while `required` still named
    // it — which is its own 400.
    const out = sanitizeGeminiSchema({
      type: 'object',
      properties: { weird: { $ref: '#/definitions/Thing' } },
      required: ['weird'],
    })!;
    const props = out['properties'] as Record<string, unknown>;
    expect(props).toHaveProperty('weird');
    expect(out['required']).toEqual(['weird']);
  });

  it('sends undefined for a no-argument tool instead of an empty object', () => {
    // Gemini rejects an empty parameters object.
    expect(toGeminiParameters({ type: 'object', properties: {} })).toBeUndefined();
    expect(toGeminiParameters({})).toBeUndefined();
    expect(toGeminiParameters(undefined)).toBeUndefined();
  });

  it('leaves a already-clean Cascade tool schema unchanged', () => {
    // The built-in tools were never the problem; this must not disturb them.
    const clean = {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look up.' },
        hops: { type: 'number', description: 'Relationship hops.' },
      },
      required: ['query'],
    };
    expect(sanitizeGeminiSchema(clean)).toEqual(clean);
  });

  it('produces a payload with no key Gemini can reject', () => {
    // The end-to-end property: walk the output and assert every key is one
    // Gemini documents. This is what actually prevents a repeat.
    const allowed = new Set([
      'type', 'format', 'title', 'description', 'nullable', 'enum',
      'items', 'properties', 'required', 'propertyOrdering',
      'minItems', 'maxItems', 'minProperties', 'maxProperties',
      'minimum', 'maximum', 'minLength', 'maxLength', 'pattern',
      'example', 'default', 'anyOf',
    ]);
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`));
      if (typeof node !== 'object' || node === null) return;
      for (const [k, v] of Object.entries(node)) {
        // Keys under `properties` are user-chosen field names, not schema keys.
        if (path.endsWith('.properties')) { walk(v, `${path}.${k}`); continue; }
        expect(allowed.has(k), `unexpected key "${k}" at ${path}`).toBe(true);
        walk(v, `${path}.${k}`);
      }
    };

    const nasty = {
      type: 'object',
      $schema: 'x',
      properties: {
        owner: { type: 'string', 'x-mcp-header': 'owner' },
        opts: {
          type: 'object',
          additionalProperties: false,
          properties: { deep: { type: 'array', items: { type: 'string', const: 'z' } } },
        },
      },
    };
    walk(sanitizeGeminiSchema(nasty), '$');
  });
});
