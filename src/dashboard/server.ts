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
import type { RuntimeNode, RuntimeNodeLog, RuntimeSession } from '../types.js';
import { CASCADE_DB_FILE, GLOBAL_CONFIG_DIR, GLOBAL_RUNTIME_DB_FILE, CASCADE_CONFIG_FILE } from '../constants.js';
import { DashboardSocket } from './websocket.js';
import { authMiddleware, createToken } from './auth.js';
import { DEFAULT_DASHBOARD_PORT } from '../constants.js';
import { randomUUID } from 'node:crypto';
import type { Identity, TierLimits, BudgetConfig } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class DashboardServer {
  private app: express.Application;
  private httpServer: ReturnType<typeof createServer>;
  private socket: DashboardSocket;
  private config: CascadeConfig;
  private dashboardSecret: string;
  private store: MemoryStore;
  private globalStore: MemoryStore | null = null;
  private broadcastTimer: NodeJS.Timeout | null = null;
  private port: number;
  private workspacePath: string;

  constructor(config: CascadeConfig, store: MemoryStore, workspacePath = process.cwd()) {
    this.config = config;
    this.store = store;
    this.workspacePath = workspacePath;
    this.port = config.dashboard.port ?? DEFAULT_DASHBOARD_PORT;
    const configuredSecret = config.dashboard.secret ?? process.env['CASCADE_DASHBOARD_SECRET'];
    if (config.dashboard.auth && !configuredSecret) {
      console.warn('Dashboard auth is enabled but no secret was configured; using an ephemeral process secret.');
    }
    this.dashboardSecret = configuredSecret ?? randomUUID();
    this.app = express();
    this.httpServer = createServer(this.app);
    this.socket = new DashboardSocket(this.httpServer, {
      authRequired: config.dashboard.auth,
      secret: this.dashboardSecret,
      corsOrigin: config.dashboard.auth
        ? [`http://localhost:${this.port}`, `http://127.0.0.1:${this.port}`]
        : '*',
    });
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

  private getGlobalStore(): MemoryStore {
    if (!this.globalStore) {
      const globalDbPath = path.join(process.env['HOME'] ?? process.cwd(), GLOBAL_CONFIG_DIR, GLOBAL_RUNTIME_DB_FILE);
      this.globalStore = new MemoryStore(globalDbPath);
    }
    return this.globalStore;
  }

  private throttledBroadcast(scope: 'workspace' | 'global'): void {
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastRuntime(scope);
      this.broadcastTimer = null;
    }, 500);
  }

  private broadcastRuntime(scope: 'workspace' | 'global'): void {
    if (scope === 'global') {
      const globalStore = this.getGlobalStore();
      try {
        // Broadcast only session list (summary) to everyone
        this.socket.broadcast('runtime:update', {
          scope,
          source: 'dashboard/server',
          fetchedAt: new Date().toISOString(),
          sessions: globalStore.listRuntimeSessions(100),
          nodes: [], // No nodes in summary
          logs: [],  // No logs in summary
        });
      } catch (err) {
        console.error('Failed to broadcast global runtime:', err);
      }
      return;
    }

    // Workspace scope
    const sessions = this.store.listRuntimeSessions(100);
    this.socket.broadcast('runtime:update', {
      scope,
      source: 'dashboard/server',
      fetchedAt: new Date().toISOString(),
      sessions,
      nodes: [],
      logs: [],
    });

    // Broadcast details to active session rooms
    for (const session of sessions) {
      if (session.status === 'ACTIVE') {
        this.broadcastSessionDetails(session.sessionId);
      }
    }
  }

  private broadcastSessionDetails(sessionId: string): void {
    try {
      const nodes = this.store.listRuntimeNodes(sessionId, 500);
      const logs = this.store.listRuntimeNodeLogs(sessionId, undefined, 100);
      this.socket.broadcastToRoom(`session:${sessionId}`, 'session:details', {
        sessionId,
        nodes,
        logs,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`Failed to broadcast details for session ${sessionId}:`, err);
    }
  }

  watchRuntimeChanges(): void {
    const workspaceDbPath = path.join(this.workspacePath, CASCADE_DB_FILE);
    const globalDbPath = path.join(process.env['HOME'] ?? process.cwd(), GLOBAL_CONFIG_DIR, GLOBAL_RUNTIME_DB_FILE);
    const watchPaths = [workspaceDbPath, globalDbPath].filter((p, index, arr) => arr.indexOf(p) === index);

    for (const watchPath of watchPaths) {
      if (!fs.existsSync(watchPath)) continue;
      // Increase interval to 3s and use throttled broadcast
      fs.watchFile(watchPath, { interval: 3000 }, () => {
        this.throttledBroadcast(watchPath === globalDbPath ? 'global' : 'workspace');
      });
    }
  }

  public refreshRuntime(scope: 'workspace' | 'global' = 'workspace'): void {
    this.broadcastRuntime(scope);
  }

  private setupMiddleware(): void {
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));

    // CORS for dev
    this.app.use((_req, res, next) => {
      if (!this.config.dashboard.auth) {
        res.header('Access-Control-Allow-Origin', '*');
      }
      res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      next();
    });
  }

  private setupRoutes(): void {
    const authRequired = this.config.dashboard.auth;
    const auth = authMiddleware(this.dashboardSecret, authRequired);

    // ── Auth ────────────────────────────────────
    this.app.post('/api/auth/login', (req: Request, res: Response) => {
      const { username, password } = req.body as { username: string; password: string };
      const configuredPassword = process.env['CASCADE_DASHBOARD_PASSWORD'];
      if (authRequired && !configuredPassword) {
        res.status(503).json({ error: 'Dashboard password is not configured. Set CASCADE_DASHBOARD_PASSWORD or disable dashboard auth.' });
        return;
      }
      if (!authRequired || password === configuredPassword) {
        const token = createToken(
          { id: username, username, role: 'admin' },
          this.dashboardSecret,
        );
        res.json({ token });
      } else {
        res.status(401).json({ error: 'Invalid credentials' });
      }
    });

    // ── Commands ────────────────────────────────────
    this.app.post('/api/force-halt', auth, (req: Request, res: Response) => {
      const { sessionId, nodeId } = req.body as { sessionId?: string; nodeId?: string };
      const payload = { sessionId, nodeId, requestedAt: new Date().toISOString() };
      this.socket.broadcast('session:halt', payload);
      if (sessionId) this.socket.broadcastToRoom(`session:${sessionId}`, 'session:halt', payload);
      res.json({ success: true, ...payload });
    });

    this.app.post('/api/approve', auth, (req: Request, res: Response) => {
      const { nodeId, sessionId } = req.body as { nodeId?: string; sessionId?: string };
      const payload = { sessionId, nodeId, requestedAt: new Date().toISOString() };
      this.socket.broadcast('session:approve', payload);
      if (sessionId) this.socket.broadcastToRoom(`session:${sessionId}`, 'session:approve', payload);
      res.json({ success: true, ...payload });
    });

    this.app.post('/api/inject', auth, (req: Request, res: Response) => {
      const { message, sessionId, nodeId } = req.body as { message?: string; sessionId?: string; nodeId?: string };
      const payload = { sessionId, nodeId, message, requestedAt: new Date().toISOString() };
      this.socket.broadcast('session:message-injected', payload);
      if (sessionId) this.socket.broadcastToRoom(`session:${sessionId}`, 'session:message-injected', payload);
      res.json({ success: true, ...payload });
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
      const sessionId = req.params.id as string;
      this.store.deleteSession(sessionId);
      this.store.deleteRuntimeSession(sessionId);

      const globalDbPath = path.join(process.env['HOME'] ?? process.cwd(), GLOBAL_CONFIG_DIR, GLOBAL_RUNTIME_DB_FILE);
      const globalStore = new MemoryStore(globalDbPath);
      try {
        globalStore.deleteRuntimeSession(sessionId);
      } finally {
        globalStore.close();
      }

      this.socket.broadcast('session:deleted', { sessionId });
      this.socket.broadcast('runtime:refresh', { scope: 'workspace' });
      this.socket.broadcast('runtime:refresh', { scope: 'global' });
      res.json({ ok: true });
    });

    this.app.delete('/api/sessions', auth, (req: Request, res: Response) => {
      const body = req.body as { ids?: string[] } | undefined;
      const globalDbPath = path.join(process.env['HOME'] ?? process.cwd(), GLOBAL_CONFIG_DIR, GLOBAL_RUNTIME_DB_FILE);

      if (body?.ids && Array.isArray(body.ids) && body.ids.length > 0) {
        // Bulk delete specific sessions by IDs
        const globalStore = new MemoryStore(globalDbPath);
        try {
          for (const id of body.ids) {
            this.store.deleteSession(id);
            this.store.deleteRuntimeSession(id);
            globalStore.deleteRuntimeSession(id);
            this.socket.broadcast('session:deleted', { sessionId: id });
          }
        } finally {
          globalStore.close();
        }
        res.json({ ok: true, deleted: body.ids.length });
      } else {
        // Delete all sessions (original behavior)
        this.store.deleteAllSessions();
        res.json({ ok: true });
      }
      this.socket.broadcast('runtime:refresh', { scope: 'workspace' });
      this.socket.broadcast('runtime:refresh', { scope: 'global' });
    });

    this.app.delete('/api/runtime', auth, (_req, res) => {
      this.store.deleteAllRuntimeNodes();
      const globalDbPath = path.join(process.env['HOME'] ?? process.cwd(), GLOBAL_CONFIG_DIR, GLOBAL_RUNTIME_DB_FILE);
      const globalStore = new MemoryStore(globalDbPath);
      try {
        globalStore.deleteAllRuntimeNodes();
      } finally {
        globalStore.close();
      }
      this.socket.broadcast('runtime:refresh', { scope: 'workspace' });
      this.socket.broadcast('runtime:refresh', { scope: 'global' });
      res.json({ ok: true });
    });

    // ── Identities ──────────────────────────────
    this.app.get('/api/identities', auth, (_req, res) => {
      res.json(this.store.listIdentities());
    });

    this.app.post('/api/identities', auth, (req: Request, res: Response) => {
      const body = req.body as Partial<Identity> & { setDefault?: boolean };
      if (!body.name) { res.status(400).json({ error: 'name is required' }); return; }
      if (body.setDefault) {
        const existing = this.store.getDefaultIdentity();
        if (existing) this.store.updateIdentity(existing.id, { isDefault: false });
      }
      const id = randomUUID();
      const identity: Identity = {
        id,
        name: body.name,
        description: body.description,
        systemPrompt: body.systemPrompt,
        isDefault: body.setDefault ?? false,
        createdAt: new Date().toISOString(),
      };
      this.store.createIdentity(identity);
      res.json(identity);
    });

    this.app.put('/api/identities/:id', auth, (req: Request, res: Response) => {
      const identityId = req.params.id as string;
      const body = req.body as Partial<Identity> & { setDefault?: boolean };
      if (body.setDefault) {
        const existing = this.store.getDefaultIdentity();
        if (existing && existing.id !== identityId) this.store.updateIdentity(existing.id, { isDefault: false });
        body.isDefault = true;
      }
      this.store.updateIdentity(identityId, body);
      res.json({ ok: true });
    });

    this.app.delete('/api/identities/:id', auth, (req: Request, res: Response) => {
      this.store.deleteIdentity(req.params.id as string);
      res.json({ ok: true });
    });

    // ── Audit log ───────────────────────────────
    this.app.get('/api/audit/:sessionId', auth, (req, res) => {
      const log = this.store.getAuditLog(req.params.sessionId as string);
      res.json(log);
    });

    this.app.get('/api/config', auth, (_req, res) => {
      // Strip sensitive fields before sending
      const safe = { ...this.config };
      safe.providers = safe.providers.map((p) => ({ ...p, apiKey: p.apiKey ? '***' : undefined }));
      res.json(safe);
    });

    this.app.put('/api/config', auth, async (req: Request, res: Response) => {
      const body = req.body as { tierLimits?: TierLimits; budget?: BudgetConfig };
      if (body.tierLimits) this.config.tierLimits = { ...this.config.tierLimits, ...body.tierLimits };
      if (body.budget)     this.config.budget     = { ...this.config.budget,     ...body.budget };
      // Persist to .cascade/config.json
      try {
        const configPath = path.join(this.workspacePath, CASCADE_CONFIG_FILE);
        const existing = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf-8')) : {};
        const updated = { ...existing, tierLimits: this.config.tierLimits, budget: this.config.budget };
        fs.writeFileSync(configPath, JSON.stringify(updated, null, 2), 'utf-8');
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: `Failed to save config: ${String(err)}` });
      }
    });

    // ── Log History ─────────────────────────────
    this.app.get('/api/runtime/logs/:sessionId', auth, (req: Request, res: Response) => {
      const sessionId = req.params['sessionId'] as string;
      const before = req.query['before'] as string | undefined;
      const limitStr = req.query['limit'] as string | undefined;
      const logs = this.store.listRuntimeNodeLogs(
        sessionId,
        before,
        parseInt(limitStr || '100', 10),
      );
      res.json(logs);
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
            scope,
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
        scope: 'workspace',
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
