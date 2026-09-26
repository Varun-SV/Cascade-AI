import path from 'node:path';
import type { CloudEnv } from './env.js';

// WorldStateDB, the audit log, and uploaded attachments all live under a
// per-tenant directory so nothing crosses between tenants.
export function tenantScratchDir(env: CloudEnv, userId: string): string {
  return path.join(path.resolve(env.DATA_DIR), 'tenants', userId);
}

// What Cascade keeps about a tenant's runs — settings, the audit trail, what
// local-only subtasks made — beside the scratch folder, not in it: the
// scratch folder is the runs' workspace, which their tools can read.
export function tenantStateDir(env: CloudEnv, userId: string): string {
  return path.join(path.resolve(env.DATA_DIR), 'tenant-state', userId);
}
