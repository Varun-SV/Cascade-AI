import { describe, it, expect } from 'vitest';
import { loadEnv, dataDirIsRailwayVolume } from './env.js';

const BASE = { SESSION_SECRET: 'a-very-long-session-secret' } as NodeJS.ProcessEnv;

describe('loadEnv — DATA_DIR / Railway volume resolution', () => {
  it('defaults DATA_DIR to ./data with no volume attached', () => {
    const env = loadEnv({ ...BASE });
    expect(env.DATA_DIR).toBe('./data');
    expect(dataDirIsRailwayVolume).toBe(false);
  });

  it('falls back to the Railway volume when DATA_DIR is unset', () => {
    const env = loadEnv({ ...BASE, RAILWAY_VOLUME_MOUNT_PATH: '/data' });
    expect(env.DATA_DIR).toBe('/data');
    expect(dataDirIsRailwayVolume).toBe(true);
  });

  it('lets an explicit DATA_DIR win over the volume', () => {
    const env = loadEnv({ ...BASE, DATA_DIR: '/custom', RAILWAY_VOLUME_MOUNT_PATH: '/data' });
    expect(env.DATA_DIR).toBe('/custom');
    expect(dataDirIsRailwayVolume).toBe(false);
  });

  it('treats an empty DATA_DIR as unset and uses the volume', () => {
    const env = loadEnv({ ...BASE, DATA_DIR: '', RAILWAY_VOLUME_MOUNT_PATH: '/data' });
    expect(env.DATA_DIR).toBe('/data');
    expect(dataDirIsRailwayVolume).toBe(true);
  });
});
