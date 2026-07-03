// ─────────────────────────────────────────────
//  Cascade AI — Dashboard Express Server
// ─────────────────────────────────────────────

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express, { type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import type { CascadeConfig } from '../types.js';
import { MemoryStore } from '../memory/store.js';
import type { RuntimeNode, RuntimeNodeLog, RuntimeSession } from '../types.js';
import { CASCADE_DB_FILE, GLOBAL_CONFIG_DIR, GLOBAL_RUNTIME_DB_FILE, CASCADE_CONFIG_FILE, CASCADE_DASHBOARD_SECRET_FILE } from '../constants.js';
import { DashboardSocket } from './websocket.js';
import { authMiddleware, createToken } from './auth.js';
import { DEFAULT_DASHBOARD_PORT } from '../constants.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Identity, TierLimits, BudgetConfig } from '../types.js';
import { Cascade } from '../core/cascade.js';
import { WorldStateDB } from '../core/knowledge/world-state.js';

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
  private activeSessions = new Map<string, import('../core/cascade.js').Cascade>();
  private activeControllers = new Map<string, AbortController>();
  /**
   * Run taskIds per chat session — file snapshots are keyed by the run's
   * taskId (see t3-worker saveSnapshot), so session rollback needs the list
   * of runs the session performed in this server's lifetime.
   */
  private sessionTaskIds = new Map<string, string[]>();
  /**
   * Tool-approval requests awaiting a user decision from a connected client,
   * keyed by the request's uuid. The desktop shows a modal on
   * `permission:user-required` and answers with `permission:decision`; this
   * map is how that answer reaches the run that's blocked on it.
   */
  private pendingApprovals = new Map<string, { resolve: (d: { approved: boolean; always: boolean }) => void; sessionId: string }>();
  private port: number;
  private host: string;
  private workspacePath: string;

  constructor(config: CascadeConfig, store: MemoryStore, workspacePath = process.cwd()) {
    this.config = config;
    this.store = store;
    this.workspacePath = workspacePath;
    this.port = config.dashboard.port ?? DEFAULT_DASHBOARD_PORT;
    this.host = config.dashboard.host ?? '127.0.0.1';
    this.dashboardSecret = this.resolveDashboardSecret();
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
    this.socket.onSessionRate((sessionId, rating) => {
      this.activeSessions.get(sessionId)?.rateLastRun(rating);
    });
    // Settings panel: reply with a redacted snapshot so the UI can pre-fill the
    // current per-tier models, budget, and which providers already have a key
    // (the keys themselves are never sent back to the renderer).
    this.socket.onConfigGet((socketId) => {
      this.socket.emitToSocket(socketId, 'config:current', {
        models: this.config.models ?? {},
        budget: {
          maxCostPerRun: this.config.budget?.maxCostPerRunUsd,
          autoBias: this.config.autoBias,
        },
        providersWithKey: (this.config.providers ?? [])
          .filter((p) => typeof p.apiKey === 'string' && p.apiKey.length > 0)
          .map((p) => p.type),
      });
    });
    this.socket.onConfigUpdate((data) => {
      if (data.keys) {
        for (const [type, apiKey] of Object.entries(data.keys)) {
          if (!apiKey) continue;
          const provider = this.config.providers.find((p) => p.type === (type as import('../types.js').ProviderType));
          if (provider) provider.apiKey = apiKey;
          else this.config.providers.push({ type: type as import('../types.js').ProviderType, apiKey });
        }
      }
      if (data.models) {
        // A tier value may be a bare model id, a `provider:model` binding, or
        // 'auto' / '' meaning "no override — let routing pick". Store explicit
        // bindings; clear the override entirely for auto so the router falls
        // back to its priority defaults instead of hunting for a model named
        // "auto".
        const models = this.config.models as Record<string, string | undefined>;
        for (const [tier, val] of Object.entries(data.models)) {
          if (val && val !== 'auto') models[tier] = val;
          else delete models[tier];
        }
      }
      if (data.budget) {
        if (typeof data.budget.maxCostPerRun === 'number') {
          this.config.budget.maxCostPerRunUsd = data.budget.maxCostPerRun;
        }
        if (data.budget.autoBias === 'balanced' || data.budget.autoBias === 'quality' || data.budget.autoBias === 'cost') {
          this.config.autoBias = data.budget.autoBias;
        }
      }
      // Persist so Settings changes survive a restart and are visible to the CLI
      // (the desktop app and `cascade` share the same workspace config file).
      this.persistConfig();
    });

    this.socket.onCascadeRun(async (prompt, model, socketId, requestedSessionId, forceTier) => {
      const sessionId = requestedSessionId ?? randomUUID();
      const abortController = new AbortController();
      this.activeControllers.set(sessionId, abortController);

      // Resuming an existing session: fold its stored history into the prompt
      // (built before persistRunStart so the new prompt isn't self-included).
      const runPrompt = requestedSessionId ? this.buildContinuationPrompt(sessionId, prompt) : prompt;
      const title = this.persistRunStart(sessionId, prompt);
      let cfg = model !== 'auto'
        ? { ...this.config, models: { ...this.config.models, t1: model } }
        : this.config;
      // Per-run manual tier override from the Cockpit selector.
      if (forceTier) cfg = { ...cfg, routing: { ...cfg.routing, forceTier: forceTier as 'T1' | 'T2' | 'T3' } };
      const cascade = new Cascade(cfg, this.workspacePath, this.store);
      this.activeSessions.set(sessionId, cascade);

      cascade.on('stream:token', (e: { text: string; tierId: string; primary?: boolean }) => {
        this.socket.emitToSocket(socketId, 'stream:token', { sessionId, tierId: e.tierId, text: e.text, primary: e.primary });
      });
      cascade.on('tier:status', (e: unknown) => {
        this.socket.emitToSocket(socketId, 'tier:status', { sessionId, ...(e as object) });
      });
      cascade.on('permission:user-required', (e: unknown) => {
        this.socket.emitToSocket(socketId, 'permission:user-required', { sessionId, ...(e as object) });
      });
      cascade.on('peer:message', (e: unknown) => {
        this.socket.emitPeerMessage(e as import('../types.js').PeerMessageEvent);
      });

      try {
        const result = await cascade.run({
          prompt: runPrompt,
          signal: abortController.signal,
          approvalCallback: this.makeApprovalCallback(sessionId),
        });
        this.recordSessionTask(sessionId, result.taskId);
        this.persistRunEnd(sessionId, title, prompt, result.output, 'COMPLETED');
        this.socket.emitToSocket(socketId, 'session:complete', { sessionId, result });
        this.socket.broadcast('cost:update', {
          sessionId,
          totalTokens: result.usage.totalTokens,
          totalCostUsd: result.usage.estimatedCostUsd,
        });
        this.throttledBroadcast('workspace');
      } catch (err) {
        this.persistRunEnd(sessionId, title, prompt, undefined, 'FAILED');
        this.socket.emitToSocket(socketId, 'session:error', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this.activeSessions.delete(sessionId);
        this.activeControllers.delete(sessionId);
        this.denyPendingApprovals(sessionId);
      }
    });

    this.socket.onSessionHalt((sessionId) => {
      this.activeControllers.get(sessionId)?.abort();
      // Unblock any tool waiting on approval so the aborted run can unwind.
      this.denyPendingApprovals(sessionId);
    });

    // The desktop/web approval modal answers here. Resolve the run that's
    // blocked on this exact request id (uuid — not guessable across sessions).
    this.socket.onApprovalResponse(({ requestId, approved, always }) => {
      const pending = this.pendingApprovals.get(requestId);
      if (!pending) return;
      this.pendingApprovals.delete(requestId);
      pending.resolve({ approved: !!approved, always: !!always });
    });

    this.socket.onSessionSteer((message, sessionId, nodeId) => {
      const steered = this.steerSessions(message, sessionId, nodeId);
      if (steered > 0) {
        this.socket.broadcast('session:message-injected', { sessionId, nodeId, message, steered, requestedAt: new Date().toISOString() });
      }
    });
  }

  async start(): Promise<void> {
    const isLoopback = this.host === '127.0.0.1' || this.host === '::1' || this.host === 'localhost';
    if (!isLoopback) {
      console.warn(
        `⚠ Dashboard is binding to ${this.host}:${this.port} — reachable from the network. ` +
        `It exposes task execution (/api/run) and config endpoints. ` +
        `Ensure dashboard.auth is enabled and CASCADE_DASHBOARD_PASSWORD is set.`,
      );
      if (!this.config.dashboard.auth) {
        console.warn('⚠ Dashboard auth is DISABLED while bound to a non-loopback interface — this allows unauthenticated remote task execution.');
      }
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.httpServer.once('error', onError);
      this.httpServer.listen(this.port, this.host, () => {
        this.httpServer.off('error', onError);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    // Cancel any pending throttled broadcast so we don't fire a broadcast
    // on an already-closed socket (which logs noisy errors and keeps the
    // event loop alive).
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    this.socket.close();
    // Release the lazily-opened global runtime DB handle so the caller can
    // safely reopen the dashboard or delete the underlying file.
    try { this.globalStore?.close(); } catch { /* ignore */ }
    this.globalStore = null;
    await new Promise<void>((resolve, reject) => {
      this.httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  }

  getSocket(): DashboardSocket {
    return this.socket;
  }

  /**
   * Write the in-memory config back to the workspace config file so mutations
   * made over the socket (Settings → Save) persist across restarts. Best-effort:
   * a write failure is logged but never crashes the running dashboard.
   */
  private persistConfig(): void {
    try {
      const configPath = path.join(this.workspacePath, CASCADE_CONFIG_FILE);
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (err) {
      console.warn(`[dashboard] Failed to persist config: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Produce a stable dashboard JWT signing secret.
   *
   * Order of precedence: explicit config → env var → secret file on disk
   * (auto-created with 0600 perms). Previously this generated a fresh UUID
   * on every process start which invalidated all outstanding JWTs.
   */
  private resolveDashboardSecret(): string {
    const fromConfig = this.config.dashboard.secret ?? process.env['CASCADE_DASHBOARD_SECRET'];
    if (fromConfig) return fromConfig;

    const secretPath = path.join(this.workspacePath, CASCADE_DASHBOARD_SECRET_FILE);
    try {
      if (fs.existsSync(secretPath)) {
        const existing = fs.readFileSync(secretPath, 'utf-8').trim();
        if (existing.length >= 16) return existing;
      }
      const generated = randomUUID();
      fs.mkdirSync(path.dirname(secretPath), { recursive: true });
      fs.writeFileSync(secretPath, generated, { encoding: 'utf-8', mode: 0o600 });
      if (this.config.dashboard.auth) {
        console.warn(
          `Dashboard auth enabled with no secret configured; persisted a generated secret to ${secretPath}. ` +
          `Set CASCADE_DASHBOARD_SECRET or config.dashboard.secret to override.`,
        );
      }
      return generated;
    } catch {
      // Read-only FS fallback: use an ephemeral secret but warn loudly.
      console.warn('Unable to persist dashboard secret; falling back to a process-ephemeral secret.');
      return randomUUID();
    }
  }

  /**
   * Resolve the dashboard password as a bcrypt hash.
   * Accepts either a pre-hashed `CASCADE_DASHBOARD_PASSWORD_HASH` or a plain
   * `CASCADE_DASHBOARD_PASSWORD` which is hashed once at startup.
   */
  private resolvePasswordHash(): string | null {
    const preHashed = process.env['CASCADE_DASHBOARD_PASSWORD_HASH'];
    if (preHashed && preHashed.startsWith('$2')) return preHashed;
    const plain = process.env['CASCADE_DASHBOARD_PASSWORD'];
    if (!plain) return null;
    return bcrypt.hashSync(plain, 10);
  }

  // ── Setup ─────────────────────────────────────

  private getGlobalStore(): MemoryStore {
    if (!this.globalStore) {
      const globalDbPath = path.join(os.homedir(), GLOBAL_CONFIG_DIR, GLOBAL_RUNTIME_DB_FILE);
      this.globalStore = new MemoryStore(globalDbPath);
    }
    return this.globalStore;
  }

  // ── Desktop-run session persistence ─────────
  // Only the CLI REPL used to persist sessions; runs started from the desktop
  // (socket `cascade:run` and REST /api/run) wrote nothing to the store, so
  // they never appeared in the session list and couldn't be resumed. These
  // helpers give both run paths the same persistence the CLI has.

  /** Record run start: session row (if new), the user message, and an ACTIVE runtime row. Returns the session title. */
  private persistRunStart(sessionId: string, prompt: string): string {
    const now = new Date().toISOString();
    let title = prompt.replace(/\s+/g, ' ').trim().slice(0, 40);
    try {
      const existing = this.store.getSession(sessionId);
      if (existing) {
        title = existing.title;
      } else {
        this.store.createSession({
          id: sessionId, title, createdAt: now, updatedAt: now,
          identityId: this.config.defaultIdentityId ?? 'default',
          workspacePath: this.workspacePath, messages: [],
          metadata: { totalTokens: 0, totalCostUsd: 0, modelsUsed: [], toolsUsed: [], taskCount: 0 },
        });
      }
      this.store.addMessage({ id: randomUUID(), sessionId, role: 'user', content: prompt, timestamp: now });
    } catch (err) {
      console.warn('[dashboard] failed to persist run start:', err);
    }
    this.persistRuntimeRow(sessionId, title, 'ACTIVE', prompt);
    return title;
  }

  /** Record run end: the assistant reply (when there is one) and the runtime row's final status. */
  private persistRunEnd(sessionId: string, title: string, latestPrompt: string, reply: string | undefined, status: 'COMPLETED' | 'FAILED'): void {
    try {
      if (reply && reply.trim()) {
        this.store.addMessage({ id: randomUUID(), sessionId, role: 'assistant', content: reply, timestamp: new Date().toISOString() });
      }
    } catch (err) {
      console.warn('[dashboard] failed to persist run end:', err);
    }
    // Keep latestPrompt — the upsert overwrites every column, and losing it
    // would blank the session's preview line in the sidebar on completion.
    this.persistRuntimeRow(sessionId, title, status, latestPrompt);
  }

  /**
   * Route steering text into running Cascade instances. Targets the given
   * session, or every active session when none is specified (the desktop
   * usually has exactly one run in flight). Returns how many were reached.
   */
  private steerSessions(message: string, sessionId?: string, nodeId?: string): number {
    const targets = sessionId
      ? [this.activeSessions.get(sessionId)].filter((c): c is NonNullable<typeof c> => !!c)
      : [...this.activeSessions.values()];
    for (const cascade of targets) cascade.injectGuidance(message, nodeId);
    return targets.length;
  }

  private recordSessionTask(sessionId: string, taskId: string): void {
    const list = this.sessionTaskIds.get(sessionId) ?? [];
    list.push(taskId);
    this.sessionTaskIds.set(sessionId, list);
  }

  /**
   * Approval bridge: cascade calls this when a dangerous tool escalates to the
   * user. The request itself was already pushed to the client via the
   * `permission:user-required` forward; here we just park a resolver keyed by
   * the request id and wait for the client's `permission:decision` (handled in
   * onApprovalResponse). Never auto-approves — an unanswered request stays
   * pending until the client answers, the run ends, or the escalator's own
   * timeout denies it.
   */
  private makeApprovalCallback(sessionId: string): (request: import('../types.js').ApprovalRequest) => Promise<{ approved: boolean; always: boolean }> {
    return (request) => new Promise<{ approved: boolean; always: boolean }>((resolve) => {
      this.pendingApprovals.set(request.id, { resolve, sessionId });
    });
  }

  /** Deny + clear any approvals still pending for a session (run end / abort). */
  private denyPendingApprovals(sessionId: string): void {
    for (const [id, pending] of this.pendingApprovals) {
      if (pending.sessionId === sessionId) {
        this.pendingApprovals.delete(id);
        pending.resolve({ approved: false, always: false });
      }
    }
  }

  private persistRuntimeRow(sessionId: string, title: string, status: 'ACTIVE' | 'COMPLETED' | 'FAILED', latestPrompt?: string): void {
    const now = new Date().toISOString();
    const row: RuntimeSession = { sessionId, title, workspacePath: this.workspacePath, status, startedAt: now, updatedAt: now, latestPrompt, isGlobal: false };
    try { this.store.upsertRuntimeSession(row); } catch (err) { console.warn('[dashboard] runtime upsert failed:', err); }
    try { this.getGlobalStore().upsertRuntimeSession({ ...row, isGlobal: true }); } catch { /* global store unavailable */ }
    this.throttledBroadcast('workspace');
  }

  /**
   * Continuing an existing session: the Cascade orchestrator is per-run and
   * stateless across runs, so prepend a compact transcript of the stored
   * conversation to the new prompt. Called BEFORE persistRunStart so the new
   * prompt isn't duplicated into its own context.
   */
  private buildContinuationPrompt(sessionId: string, prompt: string): string {
    try {
      const history = this.store.getSessionMessages(sessionId);
      if (history.length === 0) return prompt;
      const lines = history.slice(-10).map((m) => {
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return `${m.role === 'user' ? 'User' : 'Assistant'}: ${text.slice(0, 2000)}`;
      });
      return `Conversation so far (for context):\n${lines.join('\n')}\n\nUser's new message:\n${prompt}`;
    } catch {
      return prompt;
    }
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
    const globalDbPath = path.join(os.homedir(), GLOBAL_CONFIG_DIR, GLOBAL_RUNTIME_DB_FILE);
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
    const passwordHash = authRequired ? this.resolvePasswordHash() : null;

    // Brute-force protection: 5 attempts / 15 min per IP.
    const loginLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 5,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'Too many login attempts. Try again in 15 minutes.' },
    });

    // General API limiter: 60 req/min per IP on all /api routes.
    const apiLimiter = rateLimit({
      windowMs: 60 * 1000,
      limit: 60,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'Too many requests. Slow down.' },
    });
    this.app.use('/api', apiLimiter);

    // Stricter limiter for mutation/execution endpoints: 10 req/min per IP.
    const mutationLimiter = rateLimit({
      windowMs: 60 * 1000,
      limit: 10,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'Too many requests on this endpoint.' },
    });

    // ── Auth ────────────────────────────────────
    this.app.post('/api/auth/login', loginLimiter, (req: Request, res: Response) => {
      const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
      if (!authRequired) {
        const token = createToken(
          { id: username ?? 'anonymous', username: username ?? 'anonymous', role: 'admin' },
          this.dashboardSecret,
        );
        res.json({ token });
        return;
      }
      if (!passwordHash) {
        res.status(503).json({
          error: 'Dashboard password is not configured. Set CASCADE_DASHBOARD_PASSWORD (or CASCADE_DASHBOARD_PASSWORD_HASH) or disable dashboard auth.',
        });
        return;
      }
      if (typeof password !== 'string' || typeof username !== 'string') {
        res.status(400).json({ error: 'username and password are required' });
        return;
      }
      // bcrypt.compareSync is constant-time; we additionally gate on a
      // timingSafeEqual over the stringified result to preserve the same
      // response timing for both branches.
      const ok = bcrypt.compareSync(password, passwordHash);
      const truthy = Buffer.from('1');
      const falsy = Buffer.from('0');
      const probe = ok ? truthy : falsy;
      const authorized = timingSafeEqual(probe, truthy);
      if (authorized) {
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
    this.app.post('/api/force-halt', auth, mutationLimiter, (req: Request, res: Response) => {
      const body = req.body as Record<string, unknown>;
      const sessionId = typeof body['sessionId'] === 'string' ? body['sessionId'] : undefined;
      const nodeId = typeof body['nodeId'] === 'string' ? body['nodeId'] : undefined;
      const payload = { sessionId, nodeId, requestedAt: new Date().toISOString() };
      this.socket.broadcast('session:halt', payload);
      if (sessionId) this.socket.broadcastToRoom(`session:${sessionId}`, 'session:halt', payload);
      res.json({ success: true, ...payload });
    });

    // Tool approval is answered over the socket (`permission:decision` →
    // onApprovalResponse), which actually resolves the blocked run. The old
    // POST /api/approve only broadcast a `session:approve` event nothing
    // consumed, so it was removed to avoid implying a working REST path.

    this.app.post('/api/inject', auth, mutationLimiter, (req: Request, res: Response) => {
      const body = req.body as Record<string, unknown>;
      const message = typeof body['message'] === 'string' ? body['message'] : undefined;
      const sessionId = typeof body['sessionId'] === 'string' ? body['sessionId'] : undefined;
      const nodeId = typeof body['nodeId'] === 'string' ? body['nodeId'] : undefined;
      if (!message) {
        res.status(400).json({ error: 'message is required and must be a string' });
        return;
      }
      // Deliver the guidance to the live run: the target session's Cascade
      // (or every active one when no sessionId is given) queues it for its T3
      // workers' next agent-loop iteration.
      const steered = this.steerSessions(message, sessionId, nodeId);
      const payload = { sessionId, nodeId, message, steered, requestedAt: new Date().toISOString() };
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

      const globalDbPath = path.join(os.homedir(), GLOBAL_CONFIG_DIR, GLOBAL_RUNTIME_DB_FILE);
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

    // ── Export / Import ─────────────────────────
    // Chats (sessions + messages) as a portable plaintext-JSON bundle, with
    // optional "memories" (world-state knowledge + identities). Import never
    // overwrites: sessions get fresh ids, facts merge newer-wins, identities
    // dedupe by name. API keys/config are never part of a bundle.
    this.app.get('/api/export', auth, (req: Request, res: Response) => {
      try {
        const sessionsParam = typeof req.query['sessions'] === 'string' ? req.query['sessions'] : 'all';
        const includeMemories = req.query['memories'] === '1' || req.query['memories'] === 'true';
        const ids = sessionsParam === 'all' ? undefined : sessionsParam.split(',').map((s) => s.trim()).filter(Boolean);
        const bundle: Record<string, unknown> = {
          format: 'cascade-export@1',
          exportedAt: new Date().toISOString(),
          sessions: this.store.exportSessions(ids),
        };
        if (includeMemories) {
          const ws = new WorldStateDB(this.workspacePath);
          try {
            bundle['memories'] = { ...ws.exportKnowledge(), identities: this.store.listIdentities() };
          } finally {
            ws.close();
          }
        }
        res.json(bundle);
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // Body size is capped by the app-wide express.json limit (10mb).
    this.app.post('/api/import', auth, mutationLimiter, (req: Request, res: Response) => {
      try {
        const bundle = req.body as {
          format?: string;
          sessions?: Parameters<MemoryStore['importSessions']>[0];
          memories?: {
            facts?: Array<{ entity?: string; relation?: string; value?: string; sourceWorker?: string; timestamp?: string }>;
            worldLog?: Array<{ workerId?: string; summary?: string; timestamp?: string }>;
            identities?: Parameters<MemoryStore['importIdentities']>[0];
          };
        };
        if (!bundle || bundle.format !== 'cascade-export@1') {
          res.status(400).json({ error: 'Not a cascade-export@1 bundle.' });
          return;
        }
        const importedSessions = Array.isArray(bundle.sessions) ? this.store.importSessions(bundle.sessions) : [];
        // Mirror into the runtime list so the sidebar shows them immediately.
        for (const s of importedSessions) this.persistRuntimeRow(s.id, s.title, 'COMPLETED');

        let facts = 0;
        let logEntries = 0;
        let identities = 0;
        if (bundle.memories) {
          const ws = new WorldStateDB(this.workspacePath);
          try {
            const counts = ws.importKnowledge(bundle.memories);
            facts = counts.facts;
            logEntries = counts.logEntries;
          } finally {
            ws.close();
          }
          if (Array.isArray(bundle.memories.identities)) {
            identities = this.store.importIdentities(bundle.memories.identities);
          }
        }
        this.socket.broadcast('runtime:refresh', { scope: 'workspace' });
        res.json({ ok: true, imported: { sessions: importedSessions.length, facts, logEntries, identities } });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // Restore every file this session's runs touched to its pre-run state
    // (the same snapshots the CLI's /rollback uses). Snapshots are keyed by
    // run taskId, tracked per session in sessionTaskIds for this app run.
    this.app.post('/api/sessions/:id/rollback', auth, mutationLimiter, async (req: Request, res: Response) => {
      const sessionId = req.params.id as string;
      const taskIds = this.sessionTaskIds.get(sessionId) ?? [];
      if (!taskIds.length) {
        res.json({ ok: true, restored: 0, message: 'No file snapshots recorded for this session in the current app run.' });
        return;
      }
      // Runs in chronological order; the FIRST snapshot seen per file is the
      // oldest "before" state, which is what a session-wide rollback restores.
      const toRestore = new Map<string, string>();
      for (const taskId of taskIds) {
        for (const { filePath, content } of this.store.getLatestFileSnapshots(taskId)) {
          if (!toRestore.has(filePath)) toRestore.set(filePath, content);
        }
      }
      const { writeFile } = await import('node:fs/promises');
      let restored = 0;
      for (const [filePath, content] of toRestore) {
        try { await writeFile(filePath, content, 'utf-8'); restored++; }
        catch (err) { console.warn(`[dashboard] rollback restore failed: ${filePath}`, err); }
      }
      res.json({ ok: true, restored });
    });

    this.app.delete('/api/sessions', auth, (req: Request, res: Response) => {
      const body = req.body as { ids?: string[] } | undefined;
      const globalDbPath = path.join(os.homedir(), GLOBAL_CONFIG_DIR, GLOBAL_RUNTIME_DB_FILE);

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
      const globalDbPath = path.join(os.homedir(), GLOBAL_CONFIG_DIR, GLOBAL_RUNTIME_DB_FILE);
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
    // NOTE: registered before /api/audit/:sessionId so "verify" isn't
    // swallowed by the param route.
    this.app.get('/api/audit/verify', auth, async (_req, res) => {
      try {
        const { AuditLogger } = await import('../core/audit/audit-logger.js');
        const logger = new AuditLogger(this.workspacePath);
        try {
          res.json(logger.verifyChain());
        } finally {
          logger.close();
        }
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

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
      const body = req.body as Record<string, unknown>;
      // Validate shape before mutating in-memory config
      if (body['tierLimits'] !== undefined && (typeof body['tierLimits'] !== 'object' || Array.isArray(body['tierLimits']))) {
        res.status(400).json({ error: 'tierLimits must be an object' });
        return;
      }
      if (body['budget'] !== undefined && (typeof body['budget'] !== 'object' || Array.isArray(body['budget']))) {
        res.status(400).json({ error: 'budget must be an object' });
        return;
      }
      if (body['tierLimits']) this.config.tierLimits = { ...this.config.tierLimits, ...(body['tierLimits'] as TierLimits) };
      if (body['budget'])     this.config.budget     = { ...this.config.budget,     ...(body['budget'] as BudgetConfig) };
      // Persist to .cascade/config.json atomically (write temp + rename)
      try {
        const configPath = path.join(this.workspacePath, CASCADE_CONFIG_FILE);
        const existing = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf-8')) : {};
        const updated = { ...existing, tierLimits: this.config.tierLimits, budget: this.config.budget };
        const tmp = configPath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(updated, null, 2), 'utf-8');
        fs.renameSync(tmp, configPath);
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: `Failed to save config: ${err instanceof Error ? err.message : String(err)}` });
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
        const globalDbPath = path.join(os.homedir(), GLOBAL_CONFIG_DIR, GLOBAL_RUNTIME_DB_FILE);
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

    // ── Remote Run ──────────────────────────────
    this.app.post('/api/run', auth, mutationLimiter, (req: Request, res: Response) => {
      const body = req.body as { prompt?: string; identityId?: string; sessionId?: string };
      if (!body.prompt || typeof body.prompt !== 'string') {
        res.status(400).json({ error: 'prompt is required' });
        return;
      }

      const requestedSessionId = typeof body.sessionId === 'string' && body.sessionId.trim() ? body.sessionId.trim() : undefined;
      const sessionId = requestedSessionId ?? randomUUID();
      res.json({ sessionId, status: 'ACTIVE' });

      const prompt = body.prompt;
      const runPrompt = requestedSessionId ? this.buildContinuationPrompt(sessionId, prompt) : prompt;
      const title = this.persistRunStart(sessionId, prompt);

      void (async () => {
        const cascade = new Cascade(this.config, this.workspacePath, this.store);
        this.activeSessions.set(sessionId, cascade);

        cascade.on('stream:token', (e: { text: string; tierId: string; primary?: boolean }) => {
          this.socket.broadcastToRoom(`session:${sessionId}`, 'stream:token', { sessionId, tierId: e.tierId, text: e.text, primary: e.primary });
        });
        cascade.on('tier:status', (e: unknown) => {
          this.socket.broadcastToRoom(`session:${sessionId}`, 'tier:status', { sessionId, ...(e as object) });
        });
        cascade.on('permission:user-required', (e: unknown) => {
          this.socket.broadcastToRoom(`session:${sessionId}`, 'permission:user-required', { sessionId, ...(e as object) });
        });
        cascade.on('peer:message', (e: unknown) => {
          this.socket.emitPeerMessage(e as import('../types.js').PeerMessageEvent);
        });

        try {
          const result = await cascade.run({
            prompt: runPrompt,
            identityId: body.identityId,
            approvalCallback: this.makeApprovalCallback(sessionId),
          });
          this.recordSessionTask(sessionId, result.taskId);
          this.persistRunEnd(sessionId, title, prompt, result.output, 'COMPLETED');
          this.socket.broadcast('cost:update', {
            sessionId,
            totalTokens: result.usage.totalTokens,
            totalCostUsd: result.usage.estimatedCostUsd,
          });
          this.socket.broadcastToRoom(`session:${sessionId}`, 'session:complete', { sessionId, result });
          this.throttledBroadcast('workspace');
        } catch (err) {
          this.persistRunEnd(sessionId, title, prompt, undefined, 'FAILED');
          this.socket.broadcastToRoom(`session:${sessionId}`, 'session:error', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          this.activeSessions.delete(sessionId);
          this.denyPendingApprovals(sessionId);
        }
      })();
    });

    // ── Models ───────────────────────────────────
    this.app.get('/api/models', auth, (_req: Request, res: Response) => {
      res.json({
        t1: this.config.models?.t1 ?? 'auto',
        t2: this.config.models?.t2 ?? 'auto',
        t3: this.config.models?.t3 ?? 'auto',
        providers: this.config.providers.map((p) => ({
          type: p.type,
          label: p.label ?? p.type,
        })),
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
