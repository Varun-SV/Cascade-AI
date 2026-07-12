import { defineConfig } from '@playwright/test';

// Requires the core SDK to be built first (npm run build:cli at the repo
// root) — cloud/server depends on the "cascade-ai" workspace package, same
// as the desktop app's predev step.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    // Pinned pre-installed browser for this environment — avoids Playwright
    // fetching a headless-shell revision that doesn't match what's cached.
    launchOptions: { executablePath: '/opt/pw-browsers/chromium' },
  },
  webServer: [
    {
      command: 'npm run dev -w cascade-cloud-server',
      cwd: '../..',
      env: {
        CLOUD_DEV_BYPASS: '1',
        SESSION_SECRET: 'e2e-test-session-secret-value',
        PORT: '8787',
        WEB_ORIGIN: 'http://localhost:5173',
        DATA_DIR: './e2e-data',
      },
      url: 'http://127.0.0.1:8787/health',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: 'npm run dev',
      cwd: '.',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
