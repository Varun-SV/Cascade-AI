// ─────────────────────────────────────────────
//  Cascade Cloud Server — Entry Point
// ─────────────────────────────────────────────

import dotenv from 'dotenv';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv } from './env.js';
import { CloudStore } from './db.js';
import { createApp } from './app.js';
import { attachSocket } from './socket.js';

export function bootstrap() {
  dotenv.config();
  const env = loadEnv();
  const store = new CloudStore(path.join(env.DATA_DIR, 'cloud.db'));
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
