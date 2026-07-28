// ─────────────────────────────────────────────
//  Cascade AI — JSON Schema → Gemini Schema
// ─────────────────────────────────────────────
//
//  Gemini's `function_declarations[].parameters` is not JSON Schema. It is a
//  narrow subset of OpenAPI 3.0's Schema object, and — unlike every other
//  provider Cascade talks to — it REJECTS unknown fields outright with a 400
//  instead of ignoring them.
//
//  That matters because tool schemas do not all come from Cascade. MCP servers
//  supply their own, and real ones carry vendor extensions: GitHub's MCP server
//  annotates properties with `x-mcp-header`, others add `$schema`,
//  `additionalProperties`, `const`, `exclusiveMinimum`. Passing those through
//  produced:
//
//    Unknown name "x-mcp-header" at 'tools[0].function_declarations[2]
//      .parameters.properties[2].value': Cannot find field.
//
//  …repeated once per offending property, and the request never reached the
//  model. Every prompt failed identically — an image request, a code question,
//  "hi" — because the failure is in the tool envelope, not the message. Any
//  user with an MCP server connected and Gemini selected was hard-blocked.
//
//  So this converts rather than casts: an ALLOWLIST of fields Gemini documents,
//  applied recursively. Allowlisting (not blocklisting `x-*`) is the load-
//  bearing choice — the next extension nobody has seen yet is dropped for free,
//  where a blocklist would have to be updated after each new 400.

/** Fields Gemini's Schema accepts. Anything else is dropped. */
const ALLOWED_KEYS = new Set([
  'type', 'format', 'title', 'description', 'nullable', 'enum',
  'items', 'properties', 'required', 'propertyOrdering',
  'minItems', 'maxItems', 'minProperties', 'maxProperties',
  'minimum', 'maximum', 'minLength', 'maxLength', 'pattern',
  'example', 'default', 'anyOf',
]);

/** Types Gemini understands. `null` is expressed via `nullable`, not a type. */
const ALLOWED_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Normalise a `type` that JSON Schema allows to be an array (`["string",
 * "null"]`) into Gemini's single type + `nullable`, which is the only shape it
 * accepts.
 */
function normalizeType(value: unknown): { type?: string; nullable?: boolean } {
  if (typeof value === 'string') {
    return ALLOWED_TYPES.has(value) ? { type: value } : {};
  }
  if (Array.isArray(value)) {
    const types = value.filter((t): t is string => typeof t === 'string');
    const nullable = types.includes('null');
    const concrete = types.find((t) => t !== 'null' && ALLOWED_TYPES.has(t));
    return {
      ...(concrete ? { type: concrete } : {}),
      ...(nullable ? { nullable: true } : {}),
    };
  }
  return {};
}

/**
 * Gemini requires every `enum` entry to be a string, and rejects the whole
 * request otherwise:
 *
 *   Invalid value at '…value.enum[0]' (TYPE_STRING), true
 *
 * A boolean or numeric enum is perfectly legal JSON Schema, so this stringifies
 * rather than dropping — the constraint survives, and the model still sees the
 * permitted values. Dropping the enum instead would silently widen the
 * parameter to "any string", which is a worse outcome than a slightly lossy
 * representation.
 */
function normalizeEnum(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
}

/**
 * Convert one JSON Schema node into a Gemini-safe Schema node.
 *
 * Unknown keys are dropped rather than erroring: a tool whose schema carries an
 * extension is still a perfectly usable tool, and refusing to call it would
 * turn a cosmetic incompatibility into a lost capability.
 */
export function sanitizeGeminiSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(schema)) return undefined;

  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    if (!ALLOWED_KEYS.has(key)) continue;   // ← x-mcp-header, $schema, const, …

    switch (key) {
      case 'type': {
        Object.assign(out, normalizeType(value));
        break;
      }
      case 'enum': {
        const e = normalizeEnum(value);
        if (e) out['enum'] = e;
        break;
      }
      case 'properties': {
        if (!isPlainObject(value)) break;
        const props: Record<string, unknown> = {};
        for (const [propName, propSchema] of Object.entries(value)) {
          const cleaned = sanitizeGeminiSchema(propSchema);
          // A property that sanitises to nothing (e.g. it was only `$ref`)
          // still has to exist, or `required` would name a missing field.
          props[propName] = cleaned && Object.keys(cleaned).length ? cleaned : { type: 'string' };
        }
        out['properties'] = props;
        break;
      }
      case 'items': {
        const cleaned = sanitizeGeminiSchema(value);
        if (cleaned) out['items'] = cleaned;
        break;
      }
      case 'anyOf': {
        if (!Array.isArray(value)) break;
        const variants = value
          .map((v) => sanitizeGeminiSchema(v))
          .filter((v): v is Record<string, unknown> => !!v && Object.keys(v).length > 0);
        if (variants.length) out['anyOf'] = variants;
        break;
      }
      case 'required': {
        if (Array.isArray(value)) {
          out['required'] = value.filter((r): r is string => typeof r === 'string');
        }
        break;
      }
      default:
        out[key] = value;
    }
  }

  // Gemini infers nothing: a parameters object with properties but no declared
  // type is rejected. Supplying it is safe — the presence of `properties` is
  // unambiguous about what this node is.
  if (!out['type'] && out['properties']) out['type'] = 'object';
  if (!out['type'] && out['items']) out['type'] = 'array';

  return out;
}

/**
 * Sanitize a tool's top-level input schema for Gemini.
 *
 * Gemini rejects an empty `parameters` object, so a tool that takes no
 * arguments must send `undefined` rather than `{}`.
 */
export function toGeminiParameters(inputSchema: unknown): Record<string, unknown> | undefined {
  const cleaned = sanitizeGeminiSchema(inputSchema);
  if (!cleaned) return undefined;
  const props = cleaned['properties'];
  if (isPlainObject(props) && Object.keys(props).length === 0) return undefined;
  if (Object.keys(cleaned).length === 0) return undefined;
  return cleaned;
}
