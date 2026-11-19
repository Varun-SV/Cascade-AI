// ─────────────────────────────────────────────
//  Cascade Cloud Server — Entry Point
// ─────────────────────────────────────────────

import dotenv from 'dotenv';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, dataDirIsRailwayVolume } from './env.js';
import { CloudStore } from './db.js';
import { createApp } from './app.js';
import { attachSocket } from './socket.js';
import { startPendingMediaSweeper } from './pending-media.js';
import { createBrowserRelay } from './browser-relay.js';
import { logOpenWebSearches } from './open-web-log.js';

export function bootstrap() {
  dotenv.config();
  const env = loadEnv();
  const dbPath = path.resolve(env.DATA_DIR, 'cloud.db');
  // Boot diagnostic: make it obvious WHERE data is written and whether it's on
  // durable storage. If this logs an ephemeral path on a hosted deploy, every
  // redeploy will wipe users — the operator needs to attach a volume.
  if (dataDirIsRailwayVolume) {
    console.log(`[storage] DATA_DIR=${path.resolve(env.DATA_DIR)} (Railway persistent volume) — data survives redeploys · db=${dbPath}`);
  } else if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) {
    console.warn(
      `[storage] WARNING: DATA_DIR=${path.resolve(env.DATA_DIR)} is NOT a Railway persistent volume — data will be LOST on every redeploy. ` +
        `Attach a volume in the Railway dashboard (its RAILWAY_VOLUME_MOUNT_PATH is picked up automatically) or set DATA_DIR to a mounted path. · db=${dbPath}`,
    );
  } else {
    console.log(`[storage] DATA_DIR=${path.resolve(env.DATA_DIR)} · db=${dbPath}`);
  }
  const store = new CloudStore(dbPath);
  // Off unless the operator turns it on: with it off, none of its endpoints exist.
  const browserRelay = env.BROWSER_RELAY ? createBrowserRelay({ dataDir: path.resolve(env.DATA_DIR), store }) : undefined;
  // Said once at start, so an operator who turned the hosted browser off sees that
  // their REMOTE_BROWSER_* settings are no longer read rather than wondering why.
  if (!env.HOSTED_BROWSER && env.REMOTE_BROWSER_PROVIDER) {
    console.log('[browser] HOSTED_BROWSER=off: REMOTE_BROWSER_* are ignored; runs use the user\'s own browser through the relay.');
  }
  if (!env.HOSTED_BROWSER && !env.BROWSER_RELAY) {
    console.warn('[browser] HOSTED_BROWSER=off and BROWSER_RELAY is not on: runs have no browser at all.');
  }
  const app = createApp(env, store, browserRelay ? { browserRelay } : {});
  const httpServer = http.createServer(app);
  browserRelay?.attach(httpServer);
  const io = attachSocket(httpServer, env, store, browserRelay ? { browserRelay } : {});
  // Unsaved generated media expires. Request paths sweep opportunistically,
  // but an asset nobody ever opens again is exactly the one that would
  // otherwise sit on the volume forever — so the process sweeps on a timer too.
  const stopMediaSweeper = startPendingMediaSweeper(env, store);

  // One line per free web search: which sources answered, never what was asked.
  logOpenWebSearches();

  httpServer.listen(env.PORT, () => {
    console.log(`Cascade Cloud server listening on :${env.PORT}`);
  });

  const shutdown = gracefulShutdown({ httpServer, io, store, stopMediaSweeper, browserRelay });
  return { httpServer, app, io, store, env, stopMediaSweeper, browserRelay, shutdown };
}

/** How long a shutdown may take before the process exits anyway. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Shut down cleanly: Railway sends SIGTERM on every deploy and then kills the
 * process. Killed mid-connection, every browser device saw a reset and retried
 * straight into the gap before the new server was up (a 502). Instead:
 *  - paired browsers are told it is a restart (close code 1012), so they wait
 *    a few seconds before reconnecting, and every lease ends on purpose;
 *  - no new connections are accepted, open sockets are closed;
 *  - the database is closed, so its write-ahead log is folded in rather than
 *    left for the next start to recover.
 * Runs once; a hard timeout exits even if something hangs.
 */
export function gracefulShutdown(parts: {
  httpServer: http.Server;
  io: { close(cb?: () => void): unknown };
  store: { close(): void };
  stopMediaSweeper: () => void;
  browserRelay?: { close(): Promise<void> };
}): (signal: string) => Promise<void> {
  let started: Promise<void> | null = null;
  return (signal) => {
    if (started) return started;
    started = (async () => {
      console.log(`[shutdown] ${signal}: closing connections`);
      parts.stopMediaSweeper();
      await parts.browserRelay?.close().catch(() => {});
      await new Promise<void>((r) => { parts.io.close(() => r()); });
      parts.httpServer.closeAllConnections?.();
      await new Promise<void>((r) => parts.httpServer.close(() => r()));
      try { parts.store.close(); } catch { /* already closed */ }
      console.log('[shutdown] done');
    })();
    return started;
  };
}

function exitAfter(shutdown: (signal: string) => Promise<void>, signal: string): void {
  const timer = setTimeout(() => { console.warn('[shutdown] timed out; exiting'); process.exit(1); }, SHUTDOWN_TIMEOUT_MS);
  timer.unref();
  void shutdown(signal).then(() => process.exit(0), () => process.exit(1));
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  const { shutdown } = bootstrap();
  process.once('SIGTERM', () => exitAfter(shutdown, 'SIGTERM'));
  process.once('SIGINT', () => exitAfter(shutdown, 'SIGINT'));
}
