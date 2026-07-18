// ─────────────────────────────────────────────
//  Cascade AI — Code Search Tool (Phase 3)
// ─────────────────────────────────────────────

import type { ToolExecuteOptions } from '../types.js';
import { BaseTool } from './base.js';
import type { WorkspaceIndex } from '../retrieval/workspace-index.js';

const MAX_CHARS = 12_000;

/**
 * Lets a worker search the indexed workspace codebase by meaning + keywords and
 * get back the most relevant passages with their file paths. Backed by the
 * hybrid + reranked WorkspaceIndex, so it finds code by concept, not just exact
 * string match.
 */
export class CodeSearchTool extends BaseTool {
  readonly name = 'code_search';
  readonly description =
    'Search the indexed workspace codebase for code relevant to a query (semantic + keyword). Returns the most relevant snippets with their file paths. Use to find where something is implemented or how an API is used.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for (natural language or code terms).' },
      k: { type: 'number', description: 'Max snippets to return (default 6).' },
    },
    required: ['query'],
  };

  constructor(private readonly index: WorkspaceIndex) {
    super();
  }

  async execute(input: Record<string, unknown>, _options: ToolExecuteOptions): Promise<string> {
    const query = String(input['query'] ?? '').trim();
    if (!query) return 'Provide a "query" to search the codebase.';
    const k = typeof input['k'] === 'number' ? Math.max(1, Math.min(20, input['k'])) : 6;

    let hits;
    try {
      hits = await this.index.search(query, k);
    } catch (err) {
      return `Code search failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (hits.length === 0) return 'No relevant code found in the workspace index.';

    let out = '';
    for (const h of hits) {
      const block = `# ${h.sourceId}\n${h.text}\n`;
      if (out.length + block.length > MAX_CHARS) break;
      out += (out ? '\n---\n\n' : '') + block;
    }
    return out;
  }
}
