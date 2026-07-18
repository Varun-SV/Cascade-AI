// ─────────────────────────────────────────────
//  Cascade AI — Workspace code index (Phase 3)
// ─────────────────────────────────────────────
//
// Indexes a repository into the Phase-1 SQLite store for hybrid + reranked code
// search. refresh() scans the workspace, diffs a content-hash manifest against
// the stored one, and re-embeds only the files that changed (Merkle-diff style)
// — so keeping a large repo indexed stays cheap after the first pass.

import fs from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Embedder, ScoredChunk } from './types.js';
import type { Reranker } from './rerank.js';
import { Retriever } from './retriever.js';
import { SqliteVectorStore } from './sqlite-store.js';
import { chunkCode, type CodeChunker, heuristicCodeChunker } from './code-chunk.js';
import { buildManifest, diffManifest, hashContent, type FileManifest } from './manifest.js';

const DEFAULT_EXTENSIONS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'rb', 'php',
  'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'swift', 'kt', 'scala', 'sh', 'sql',
  'md', 'json', 'yaml', 'yml', 'toml',
];
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
// Directories never worth indexing even if not ignored.
const HARD_SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'out', 'target', 'vendor', '.cache', 'coverage']);

export interface WorkspaceIndexOptions {
  root: string;
  /** better-sqlite3 DB hosting vectors + the manifest. */
  db: Database.Database;
  embedder: Embedder;
  reranker?: Reranker;
  /** Predicate for paths to skip (e.g. CascadeIgnore.isIgnored bound to root). */
  isIgnored?: (absPath: string) => boolean;
  namespace?: string;
  extensions?: string[];
  maxFileBytes?: number;
  chunker?: CodeChunker;
}

export interface RefreshResult {
  filesIndexed: number;
  filesRemoved: number;
  filesUnchanged: number;
  chunks: number;
  root: string;
}

export class WorkspaceIndex {
  private readonly root: string;
  private readonly db: Database.Database;
  private readonly store: SqliteVectorStore;
  private readonly retriever: Retriever;
  private readonly namespace: string;
  private readonly extensions: Set<string>;
  private readonly maxFileBytes: number;
  private readonly isIgnored: (absPath: string) => boolean;
  private readonly chunker: CodeChunker;

  constructor(opts: WorkspaceIndexOptions) {
    this.root = path.resolve(opts.root);
    this.db = opts.db;
    this.namespace = opts.namespace ?? 'code';
    this.extensions = new Set((opts.extensions ?? DEFAULT_EXTENSIONS).map((e) => e.replace(/^\./, '').toLowerCase()));
    this.maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.isIgnored = opts.isIgnored ?? (() => false);
    this.chunker = opts.chunker ?? heuristicCodeChunker;
    this.store = new SqliteVectorStore(this.db);
    this.retriever = new Retriever(opts.embedder, this.store, opts.reranker);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS code_manifest (
        namespace TEXT NOT NULL,
        path TEXT NOT NULL,
        hash TEXT NOT NULL,
        PRIMARY KEY (namespace, path)
      );
    `);
  }

  /** Recursively collect indexable files under root (relative paths). */
  private async collectFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (HARD_SKIP_DIRS.has(entry.name) || this.isIgnored(abs)) continue;
          await walk(abs);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).slice(1).toLowerCase();
          if (!this.extensions.has(ext) || this.isIgnored(abs)) continue;
          out.push(path.relative(this.root, abs));
        }
      }
    };
    await walk(this.root);
    return out;
  }

  private loadStoredManifest(): FileManifest | null {
    const rows = this.db
      .prepare('SELECT path, hash FROM code_manifest WHERE namespace = ?')
      .all(this.namespace) as Array<{ path: string; hash: string }>;
    if (rows.length === 0) return null;
    return buildManifest(rows);
  }

  private saveManifest(manifest: FileManifest): void {
    const del = this.db.prepare('DELETE FROM code_manifest WHERE namespace = ?');
    const ins = this.db.prepare('INSERT INTO code_manifest (namespace, path, hash) VALUES (?, ?, ?)');
    const tx = this.db.transaction(() => {
      del.run(this.namespace);
      for (const [p, h] of Object.entries(manifest.files)) ins.run(this.namespace, p, h);
    });
    tx();
  }

  /**
   * Scan the workspace and bring the index up to date, re-embedding only files
   * whose contents changed since the last refresh. Returns what changed.
   */
  async refresh(onFile?: (rel: string) => void): Promise<RefreshResult> {
    const rels = await this.collectFiles();
    const entries: Array<{ path: string; hash: string; text: string }> = [];
    for (const rel of rels) {
      try {
        const abs = path.join(this.root, rel);
        const stat = await fs.stat(abs);
        if (stat.size > this.maxFileBytes) continue;
        const buf = await fs.readFile(abs);
        if (buf.includes(0)) continue; // skip binary
        entries.push({ path: rel, hash: hashContent(buf), text: buf.toString('utf8') });
      } catch {
        /* unreadable — skip */
      }
    }

    const next = buildManifest(entries.map((e) => ({ path: e.path, hash: e.hash })));
    const diff = diffManifest(this.loadStoredManifest(), next);
    const byPath = new Map(entries.map((e) => [e.path, e.text]));

    let chunks = 0;
    for (const rel of [...diff.added, ...diff.changed]) {
      onFile?.(rel);
      this.store.deleteSource(this.namespace, rel); // drop stale chunks for changed files
      const pieces = this.chunker.chunk(byPath.get(rel) ?? '', { filename: rel });
      chunks += await this.retriever.index(this.namespace, rel, pieces);
    }
    for (const rel of diff.removed) this.store.deleteSource(this.namespace, rel);

    this.saveManifest(next);
    return {
      filesIndexed: diff.added.length + diff.changed.length,
      filesRemoved: diff.removed.length,
      filesUnchanged: diff.unchanged.length,
      chunks,
      root: next.root,
    };
  }

  /** Hybrid + reranked search over the indexed codebase. */
  async search(query: string, k = 8): Promise<ScoredChunk[]> {
    return this.retriever.search(query, { namespace: this.namespace, k, candidates: 40 });
  }
}

// Re-export for callers that want to build chunks directly.
export { chunkCode };
