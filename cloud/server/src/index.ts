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
  const app = createApp(env, store);
  const httpServer = http.createServer(app);
  const io = attachSocket(httpServer, env, store);

  httpServer.listen(env.PORT, () => {
    console.log(`Cascade Cloud server listening on :${env.PORT}`);
  });

  return { httpServer, app, io, store, env };
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  bootstrap();
}
