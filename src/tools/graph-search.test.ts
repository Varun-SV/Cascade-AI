import { describe, it, expect } from 'vitest';
import { GraphSearchTool } from './graph-search.js';
import type { GraphFactSource } from '../retrieval/graph.js';
import type { WorldFact } from '../core/knowledge/world-state.js';

const fact = (entity: string, relation: string, value: string): WorldFact => ({
  entity, relation, value, sourceWorker: 't3', timestamp: '2026-01-01',
});
function source(facts: WorldFact[]): GraphFactSource {
  return {
    getAllFacts: () => facts,
    getFactsForEntities: (entities) => {
      const set = new Set(entities.map((e) => e.toLowerCase()));
      return facts.filter((f) => set.has(f.entity.toLowerCase()));
    },
  };
}
const opts = {} as never;

describe('GraphSearchTool', () => {
  it('asks for a query when missing', async () => {
    const tool = new GraphSearchTool(source([]));
    expect(await tool.execute({}, opts)).toMatch(/query/i);
  });

  it('reports when nothing related is found', async () => {
    const tool = new GraphSearchTool(source([fact('A', 'is', 'B')]));
    expect(await tool.execute({ query: 'nonexistent thing' }, opts)).toMatch(/no related facts/i);
  });

  it('returns formatted facts for a matching entity', async () => {
    const tool = new GraphSearchTool(source([fact('Payments', 'uses', 'Stripe')]));
    const out = await tool.execute({ query: 'how does Payments work' }, opts);
    expect(out).toContain('- Payments uses Stripe');
  });
});
