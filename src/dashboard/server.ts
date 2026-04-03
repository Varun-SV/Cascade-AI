// ─────────────────────────────────────────────
//  Cascade AI — Dashboard Express Server
// ─────────────────────────────────────────────

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import express, { type Request, type Response } from 'express';
import type { CascadeConfig } from '../types.js';
import { MemoryStore } from '../memory/store.js';
import { GLOBAL_CONFIG_DIR, GLOBAL_RUNTIME_DB_FILE } from '../constants.js';
import { DashboardSocket } from './websocket.js';
import { authMiddleware, createToken } from './auth.js';
import { DEFAULT_DASHBOARD_PORT } from '../constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class DashboardServer {
  private app: express.Application;
  private httpServer: ReturnType<typeof createServer>;
  private socket: DashboardSocket;
  private config: CascadeConfig;
  private store: MemoryStore;
  private port: number;

  constructor(config: CascadeConfig, store: MemoryStore) {
    this.config = config;
    this.store = store;
    this.port = config.dashboard.port ?? DEFAULT_DASHBOARD_PORT;
    this.app = express();
    this.httpServer = createServer(this.app);
    this.socket = new DashboardSocket(this.httpServer);
    this.setupMiddleware();
    this.setupRoutes();
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.httpServer.once('error', onError);
      this.httpServer.listen(this.port, () => {
        this.httpServer.off('error', onError);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.socket.close();
    await new Promise<void>((resolve, reject) => {
      this.httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  }

  getSocket(): DashboardSocket {
    return this.socket;
  }

  // ── Setup ─────────────────────────────────────

  private setupMiddleware(): void {
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));

    // CORS for dev
    this.app.use((_req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      next();
    });
  }

  private setupRoutes(): void {
    const secret = this.config.dashboard.secret ?? 'cascade-secret';
    const authRequired = this.config.dashboard.auth;
    const auth = authMiddleware(secret, authRequired);

    // ── Auth ────────────────────────────────────
    this.app.post('/api/auth/login', (req: Request, res: Response) => {
      const { username, password } = req.body as { username: string; password: string };
      // Simple password check — in production, use a proper user store
      if (password === (process.env['CASCADE_DASHBOARD_PASSWORD'] ?? 'cascade')) {
        const token = createToken(
          { id: username, username, role: 'admin' },
          secret,
        );
        res.json({ token });
      } else {
        res.status(401).json({ error: 'Invalid credentials' });
      }
    });

    // ── Sessions ────────────────────────────────
    this.app.get('/api/sessions', auth, (_req, res) => {
      const sessions = this.store.listSessions();
      res.json(sessions);
    });

    this.app.get('/api/sessions/:id', auth, (req, res) => {
      const id = req.params.id as string;
      const session = this.store.getSession(id);
      if (!session) { res.status(404).json({ error: 'Not found' }); return; }
      res.json(session);
    });

    this.app.delete('/api/sessions/:id', auth, (req, res) => {
      this.store.deleteSession(req.params.id as string);
      res.json({ ok: true });
    });

    // ── Identities ──────────────────────────────
    this.app.get('/api/identities', auth, (_req, res) => {
      res.json(this.store.listIdentities());
    });

    // ── Audit log ───────────────────────────────
    this.app.get('/api/audit/:sessionId', auth, (req, res) => {
      const log = this.store.getAuditLog(req.params.sessionId as string);
      res.json(log);
    });

    // ── Config ──────────────────────────────────
    this.app.get('/api/config', auth, (_req, res) => {
      // Strip sensitive fields before sending
      const safe = { ...this.config };
      safe.providers = safe.providers.map((p) => ({ ...p, apiKey: p.apiKey ? '***' : undefined }));
      res.json(safe);
    });

    // ── Stats ───────────────────────────────────
    this.app.get('/api/stats', auth, (_req, res) => {
      const sessions = this.store.listSessions(undefined, 1000);
      res.json({
        totalSessions: sessions.length,
        totalMessages: sessions.reduce((acc, s) => acc + s.metadata.taskCount, 0),
        totalCostUsd: sessions.reduce((acc, s) => acc + s.metadata.totalCostUsd, 0),
      });
    });

    // ── Runtime ──────────────────────────────────
    this.app.get('/api/runtime', auth, (req, res) => {
      const scope = (req.query['scope'] as string | undefined) ?? 'workspace';
      if (scope === 'global') {
        const globalDbPath = path.join(process.env['HOME'] ?? process.cwd(), GLOBAL_CONFIG_DIR, GLOBAL_RUNTIME_DB_FILE);
        const globalStore = new MemoryStore(globalDbPath);
        try {
          res.json({
            sessions: globalStore.listRuntimeSessions(200),
            nodes: globalStore.listRuntimeNodes(undefined, 1000),
            logs: globalStore.listRuntimeNodeLogs(undefined, undefined, 500),
          });
        } finally {
          globalStore.close();
        }
        return;
      }
      res.json({
        sessions: this.store.listRuntimeSessions(200),
        nodes: this.store.listRuntimeNodes(undefined, 1000),
        logs: this.store.listRuntimeNodeLogs(undefined, undefined, 500),
      });
    });

    // ── Serve React app ─────────────────────────
    // When running from built CLI, __dirname is dist/.
    // When running locally via ts-node, __dirname is src/dashboard.
    const prodPath = path.resolve(__dirname, '../web/dist');
    const devPath = path.resolve(__dirname, '../../web/dist');
    const webDistPath = fs.existsSync(prodPath) ? prodPath : devPath;

    if (fs.existsSync(webDistPath)) {
      this.app.use(express.static(webDistPath));
      this.app.get('*', (_req, res) => {
        res.sendFile(path.join(webDistPath, 'index.html'));
      });
    } else {
      this.app.get('/', (_req, res) => {
        res.send(`
          <html><body style="background:#0f0f1a;color:#e2e8f0;font-family:monospace;padding:2rem">
            <h2>◈ Cascade Dashboard</h2>
            <p>Dashboard not built yet. Run: <code>npm run build:web</code></p>
            <p>API available at <a href="/api/stats" style="color:#7c6af7">/api/stats</a></p>
          </body></html>
        `);
      });
    }
  }
}
