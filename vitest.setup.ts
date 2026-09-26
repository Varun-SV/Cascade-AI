// ─────────────────────────────────────────────
//  Cascade AI — test environment isolation
// ─────────────────────────────────────────────
//
//  Clears every provider credential and endpoint variable before each TEST —
//  `beforeEach` in a setup file runs per test, not per file — so a test asserts
//  what it sets up rather than what happens to be exported in the shell that
//  ran it, or what a previous test in the same file left behind.
//
//  This exists because of a real miss: `ANTHROPIC_BASE_URL` is set in some
//  development containers, and a test asserting that a bearer token is adopted
//  passed locally for that reason alone. It failed in CI, where the variable is
//  absent — the fix under test had made a gateway REQUIRED, and the test was
//  silently reading one out of the ambient environment. Local runs cannot be
//  trusted as a stand-in for CI while the suite can see credentials it did not
//  put there.
//
//  A test that needs one of these sets it explicitly and restores it.

import { afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Cascade's machine-global folder — credentials, and every project's state
// (config/project-state.ts) — is a temporary one for each test file, never
// the developer's own ~/.cascade-ai. Per file rather than per test: a
// fixture made in `beforeAll` has to find its project's state where its
// tests do. A project's state folder is its own, so tests with their own
// workspaces do not meet; the one file they share is the credential store,
// which is emptied before each test.
const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-global-'));
process.env['CASCADE_GLOBAL_DIR'] = globalDir;
beforeEach(() => {
  process.env['CASCADE_GLOBAL_DIR'] = globalDir;
  fs.rmSync(path.join(globalDir, 'credentials.json'), { force: true });
});
afterAll(() => { fs.rmSync(globalDir, { recursive: true, force: true }); });

const PROVIDER_ENV = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'AZURE_OPENAI_KEY', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_DEPLOYMENT', 'AZURE_OPENAI_DEPLOYMENT_NAME', 'AZURE_OPENAI_API_VERSION',
  'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'XAI_API_KEY',
  'MISTRAL_API_KEY', 'TOGETHER_API_KEY', 'FIREWORKS_API_KEY',
  'CLAUDE_CONFIG_DIR',
] as const;

beforeEach(() => {
  for (const name of PROVIDER_ENV) delete process.env[name];
});
