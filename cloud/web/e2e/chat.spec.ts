import { test, expect } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Minimal OpenAI-compatible stub — a standalone copy rather than importing
 * cloud/server's test-support helper, since Playwright here runs against the
 * built SPA in its own workspace, not through cloud/server's TS toolchain.
 */
function startStubLLM(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
      return;
    }
    if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const id = 'chatcmpl-stub';
      const created = Math.floor(Date.now() / 1000);
      const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
        `data: ${JSON.stringify({
          id, object: 'chat.completion.chunk', created, model: 'stub-model',
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`;
      res.write(chunk({ role: 'assistant', content: 'Hello ' }));
      res.write(chunk({ content: 'from the e2e stub model.' }));
      res.write(chunk({}, 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}/v1`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

// 1×1 transparent PNG.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

test('dev login -> add a key -> pick a skill -> attach an image -> send -> reply; then add a memory', async ({ page }) => {
  const stub = await startStubLLM();
  try {
    await page.goto('/');

    await page.getByPlaceholder('Your name').fill('E2E Tester');
    await page.getByText('Dev login').click();
    await expect(page.getByRole('button', { name: /API keys/ })).toBeVisible();

    // Add a provider key. Scope the provider <select> (the composer also has a
    // skill <select>) via its unique 'openai-compatible' option.
    await page.getByRole('button', { name: /API keys/ }).click();
    await page.getByText('Add provider').click();
    const providerSelect = page.locator('select').filter({ has: page.locator('option[value="openai-compatible"]') });
    await providerSelect.selectOption('openai-compatible');
    await page.getByPlaceholder('https://...').fill(stub.url);
    await page.getByText('Save').click();
    await page.getByLabel('Close').click();

    // Pick a skill preset in the composer.
    await page.getByLabel('Skill').selectOption('code-reviewer');

    // Attach an image; wait for the upload thumbnail before sending.
    await page.locator('input[type="file"]').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: TINY_PNG });
    await expect(page.locator('img[alt="pending"]')).toBeVisible();

    await page.getByPlaceholder('Message Cascade…').fill('review this');
    await page.getByLabel('Send').click();

    await expect(page.locator('[data-role="assistant"]')).toContainText('e2e stub model', { timeout: 20_000 });
    await expect(page.locator('[data-role="user"]')).toContainText('review this');
    // The uploaded image re-renders in the sent user message.
    await expect(page.locator('[data-role="user"] img')).toBeVisible();

    // Add a memory and confirm it persists in the panel.
    await page.getByRole('button', { name: /Memory/ }).click();
    await page.getByPlaceholder(/I prefer TypeScript/).fill('Prefers concise answers');
    await page.getByRole('button', { name: /^Add/ }).click();
    await expect(page.getByText('Prefers concise answers')).toBeVisible();
  } finally {
    await stub.close();
  }
});
