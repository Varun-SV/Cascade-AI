import { describe, it, expect } from 'vitest';
import { GraphRetriever, type GraphFactSource } from './graph.js';
import type { WorldFact } from '../core/knowledge/world-state.js';

const fact = (entity: string, relation: string, value: string): WorldFact => ({
  entity, relation, value, sourceWorker: 't3', timestamp: '2026-01-01',
});

// In-memory fact source mirroring WorldStateDB's two query methods.
function source(facts: WorldFact[]): GraphFactSource {
  return {
    getAllFacts: () => facts,
    getFactsForEntities: (entities) => {
      const set = new Set(entities.map((e) => e.toLowerCase()));
      return facts.filter((f) => set.has(f.entity.toLowerCase()));
    },
  };
}

describe('GraphRetriever', () => {
  const facts = [
    fact('AuthService', 'validates', 'the SessionToken'),
    fact('AuthService', 'depends_on', 'Database'),
    fact('SessionToken', 'expires_after', '24 hours'),
    fact('Database', 'hosted_on', 'Railway'),
    fact('InvoiceService', 'uses', 'Stripe'),
  ];

  it('returns nothing when the query has no known entities', () => {
    const r = new GraphRetriever(source(facts));
    expect(r.search('completely unrelated quantum physics')).toEqual([]);
  });

  it('seeds on a mentioned entity and returns its facts', () => {
    const r = new GraphRetriever(source(facts));
    const hits = r.search('how does AuthService work', { hops: 0 });
    const rels = hits.map((h) => h.relation);
    expect(rels).toContain('validates');
    expect(rels).toContain('depends_on');
    // A single-hop=0 query stays on the seed entity.
    expect(hits.every((h) => h.entity === 'AuthService')).toBe(true);
  });

  it('expands one hop by following entity references in fact values', () => {
    const r = new GraphRetriever(source(facts));
    const hits = r.search('AuthService', { hops: 1 });
    const entities = new Set(hits.map((h) => h.entity));
    // AuthService → (value mentions SessionToken, Database) → their facts pulled in.
    expect(entities.has('AuthService')).toBe(true);
    expect(entities.has('SessionToken')).toBe(true);
    expect(entities.has('Database')).toBe(true);
    // Unrelated InvoiceService is not reached.
    expect(entities.has('InvoiceService')).toBe(false);
  });

  it('reaches two hops (AuthService → Database → Railway)', () => {
    const r = new GraphRetriever(source(facts));
    const hits = r.search('AuthService', { hops: 2 });
    expect(hits.some((h) => h.entity === 'Database' && h.value.includes('Railway'))).toBe(true);
  });

  it('ranks facts overlapping the query above pure hop-neighbors', () => {
    const r = new GraphRetriever(source(facts));
    const hits = r.search('AuthService validates token', { hops: 1 });
    expect(hits[0]!.relation).toBe('validates');
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  it('formats facts as readable lines', () => {
    const r = new GraphRetriever(source(facts));
    const out = r.format(r.search('AuthService', { hops: 0 }));
    expect(out).toContain('- AuthService validates the SessionToken');
  });
});
