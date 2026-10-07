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

describe('GraphSearchTool — facts that may not leave', () => {
  const rules = { hasPolicies: () => true, isLocalOnly: (p: string) => p.startsWith('secret/') };
  const facts = [
    { ...fact('Payments', 'uses', 'Stripe'), sources: ['src/pay.ts'] },
    { ...fact('Payments', 'settles', 'weekly'), sources: null },
    { ...fact('Payments', 'owner', 'ops team'), sources: ['secret/org.md'] },
  ];

  it('shows a caller on any model only facts that may leave', async () => {
    const out = await new GraphSearchTool(source(facts), () => rules).execute({ query: 'Payments' }, opts);
    expect(out).toContain('Payments uses Stripe');
    expect(out).not.toContain('weekly');
    expect(out).not.toContain('ops team');
  });

  it('shows a local-only caller everything: it stays on this machine', async () => {
    const out = await new GraphSearchTool(source(facts), () => rules).execute({ query: 'Payments' }, { isOffline: () => true } as never);
    expect(out).toContain('weekly');
    expect(out).toContain('ops team');
  });
});
