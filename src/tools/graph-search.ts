// ─────────────────────────────────────────────
//  Cascade AI — Knowledge Graph Search Tool (Phase 4)
// ─────────────────────────────────────────────

import type { ToolExecuteOptions } from '../types.js';
import { BaseTool } from './base.js';
import { GraphRetriever, type GraphFactSource } from '../retrieval/graph.js';

const MAX_CHARS = 8_000;

/**
 * Lets a worker query the project knowledge graph (world-state) for facts
 * related to entities in the query, following relationships a couple of hops.
 * Best for relational / multi-hop questions ("what depends on X?", "which
 * component owns Y?") that vector search answers poorly.
 */
export class GraphSearchTool extends BaseTool {
  readonly name = 'knowledge_graph_search';
  readonly description =
    'Search the project knowledge graph (learned entity→relation→value facts) for information related to a query, expanding a couple of hops across relationships. Use for relational or multi-hop questions about the project.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look up (mention the entities of interest).' },
      hops: { type: 'number', description: 'Relationship hops to expand (default 1, max 3).' },
    },
    required: ['query'],
  };

  private retriever: GraphRetriever;

  constructor(source: GraphFactSource) {
    super();
    this.retriever = new GraphRetriever(source);
  }

  async execute(input: Record<string, unknown>, _options: ToolExecuteOptions): Promise<string> {
    const query = String(input['query'] ?? '').trim();
    if (!query) return 'Provide a "query" naming the entities to look up.';
    const hops = typeof input['hops'] === 'number' ? Math.max(0, Math.min(3, input['hops'])) : 1;

    const facts = this.retriever.search(query, { hops, limit: 40 });
    if (facts.length === 0) return 'No related facts found in the project knowledge graph.';

    const formatted = this.retriever.format(facts);
    return formatted.length > MAX_CHARS ? `${formatted.slice(0, MAX_CHARS)}\n…` : formatted;
  }
}
