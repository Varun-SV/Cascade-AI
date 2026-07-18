// ─────────────────────────────────────────────
//  Cascade AI — SQLite hybrid vector store (Phase 1)
// ─────────────────────────────────────────────
//
// Vectors are stored as normalized Float32 BLOBs in an ordinary SQLite table;
// dense search is exact brute-force cosine (a dot product, since vectors are
// pre-normalized). Lexical search uses SQLite's built-in FTS5 (BM25). This is
// dependency-free (no native vector extension) and exact — ideal at doc-chunk
// scale. The VectorStore interface lets us swap in an ANN index (sqlite-vec /
// LanceDB) later without touching callers.

import type Database from 'better-sqlite3';
import type { Chunk, ScoredChunk, SearchOptions, VectorStore } from './types.js';

interface ChunkRow {
  chunk_id: string;
  namespace: string;
  source_id: string;
  ord: number;
  text: string;
  vector: Buffer;
}

/** L2-normalize in place and return the same array (so cosine == dot product). */
function normalize(vec: number[]): Float32Array {
  const f = new Float32Array(vec);
  let sum = 0;
  for (let i = 0; i < f.length; i++) sum += f[i]! * f[i]!;
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < f.length; i++) f[i]! /= norm;
  return f;
}

function toBlob(f: Float32Array): Buffer {
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}
function fromBlob(buf: Buffer): Float32Array {
  // Copy into an aligned buffer — SQLite BLOBs aren't guaranteed 4-byte aligned.
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

/** Extract FTS5-safe terms from a free-text query (alnum tokens, OR-joined). */
function ftsMatchExpr(query: string): string | null {
  const terms = (query.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1).slice(0, 24);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"`).join(' OR ');
}

export class SqliteVectorStore implements VectorStore {
  constructor(private db: Database.Database) {
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kb_chunks (
        chunk_id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        source_id TEXT NOT NULL,
        ord INTEGER NOT NULL,
        text TEXT NOT NULL,
        embed_model TEXT NOT NULL,
        dims INTEGER NOT NULL,
        vector BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kb_chunks_ns_src ON kb_chunks(namespace, source_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
        text, chunk_id UNINDEXED, namespace UNINDEXED, source_id UNINDEXED
      );
    `);
  }

  upsert(records: Array<{ chunk: Chunk; vector: number[] }>, embedModel: string): void {
    if (records.length === 0) return;
    const insChunk = this.db.prepare(
      `INSERT OR REPLACE INTO kb_chunks (chunk_id, namespace, source_id, ord, text, embed_model, dims, vector, created_at)
       VALUES (@chunk_id, @namespace, @source_id, @ord, @text, @embed_model, @dims, @vector, @created_at)`,
    );
    const delFts = this.db.prepare('DELETE FROM kb_fts WHERE chunk_id = ?');
    const insFts = this.db.prepare('INSERT INTO kb_fts (text, chunk_id, namespace, source_id) VALUES (?, ?, ?, ?)');
    const now = Date.now();
    const tx = this.db.transaction((rows: Array<{ chunk: Chunk; vector: number[] }>) => {
      for (const { chunk, vector } of rows) {
        const f = normalize(vector);
        insChunk.run({
          chunk_id: chunk.id,
          namespace: (chunk.meta?.['namespace'] as string) ?? '',
          source_id: chunk.sourceId,
          ord: chunk.ord,
          text: chunk.text,
          embed_model: embedModel,
          dims: f.length,
          vector: toBlob(f),
          created_at: now,
        });
        delFts.run(chunk.id);
        insFts.run(chunk.text, chunk.id, (chunk.meta?.['namespace'] as string) ?? '', chunk.sourceId);
      }
    });
    tx(records);
  }

  hasSource(namespace: string, sourceId: string, embedModel: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM kb_chunks WHERE namespace = ? AND source_id = ? AND embed_model = ? LIMIT 1')
      .get(namespace, sourceId, embedModel);
    return !!row;
  }

  deleteSource(namespace: string, sourceId: string): void {
    this.db.prepare('DELETE FROM kb_chunks WHERE namespace = ? AND source_id = ?').run(namespace, sourceId);
    this.db.prepare('DELETE FROM kb_fts WHERE namespace = ? AND source_id = ?').run(namespace, sourceId);
  }

  lexicalSearch(query: string, opts: SearchOptions): ScoredChunk[] {
    const expr = ftsMatchExpr(query);
    if (!expr) return [];
    const k = opts.k ?? 10;
    const srcFilter = this.sourceFilter(opts.sourceIds, 'kb_fts');
    const rows = this.db
      .prepare(
        `SELECT chunk_id, source_id, text, bm25(kb_fts) AS score
         FROM kb_fts
         WHERE kb_fts MATCH ? AND namespace = ? ${srcFilter.clause}
         ORDER BY score ASC LIMIT ?`,
      )
      .all(expr, opts.namespace, ...srcFilter.params, k) as Array<{ chunk_id: string; source_id: string; text: string; score: number }>;
    // bm25() is lower-is-better; expose a higher-is-better score for readability.
    return rows.map((r, i) => ({ id: r.chunk_id, sourceId: r.source_id, ord: i, text: r.text, score: -r.score }));
  }

  denseSearch(queryVector: number[], opts: SearchOptions): ScoredChunk[] {
    const q = normalize(queryVector);
    const k = opts.k ?? 10;
    const srcFilter = this.sourceFilter(opts.sourceIds, 'kb_chunks');
    const rows = this.db
      .prepare(
        `SELECT chunk_id, source_id, ord, text, vector FROM kb_chunks
         WHERE namespace = ? ${srcFilter.clause}`,
      )
      .all(opts.namespace, ...srcFilter.params) as ChunkRow[];
    const scored = rows.map((r) => {
      const v = fromBlob(r.vector);
      let dot = 0;
      const n = Math.min(v.length, q.length);
      for (let i = 0; i < n; i++) dot += v[i]! * q[i]!;
      return { id: r.chunk_id, sourceId: r.source_id, ord: r.ord, text: r.text, score: dot };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  private sourceFilter(sourceIds: string[] | undefined, table: string): { clause: string; params: string[] } {
    if (!sourceIds || sourceIds.length === 0) return { clause: '', params: [] };
    const placeholders = sourceIds.map(() => '?').join(', ');
    return { clause: `AND ${table}.source_id IN (${placeholders})`, params: sourceIds };
  }
}
