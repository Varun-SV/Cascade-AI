import path from 'node:path';
import type { CloudEnv } from './env.js';

// WorldStateDB, the audit log, and uploaded attachments all live under a
// per-tenant directory so nothing crosses between tenants.
export function tenantScratchDir(env: CloudEnv, userId: string): string {
  return path.join(path.resolve(env.DATA_DIR), 'tenants', userId);
}
