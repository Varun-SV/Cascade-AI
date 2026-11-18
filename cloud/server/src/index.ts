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

  httpServer.listen(env.PORT, () => {
    console.log(`Cascade Cloud server listening on :${env.PORT}`);
  });

  return { httpServer, app, io, store, env, stopMediaSweeper, browserRelay };
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  bootstrap();
}
