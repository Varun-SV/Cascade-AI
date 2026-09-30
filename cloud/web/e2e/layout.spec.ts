import { test, expect } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** An OpenAI-compatible stub whose answer is long enough to scroll the thread. */
function startStubLLM(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
      return;
    }
    if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
        `data: ${JSON.stringify({
          id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'stub-model',
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`;
      const paragraph = 'A long answer, so the thread has more to show than fits on the screen. '.repeat(4);
      res.write(chunk({ role: 'assistant', content: Array.from({ length: 14 }, () => paragraph).join('\n\n') }));
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

test.use({ viewport: { width: 1024, height: 700 } });

test('a long reply scrolls the thread, not the page; the account menu stays on screen once its gauges load', async ({ page }) => {
  const stub = await startStubLLM();
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByPlaceholder('Your name').fill('Layout Tester');
    await page.getByText('Dev login').click();
    await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();

    await page.getByRole('button', { name: 'Account' }).click();
    await page.getByRole('menuitem', { name: 'API keys' }).click();
    await page.getByText('Add provider').click();
    await page.locator('select').filter({ has: page.locator('option[value="openai-compatible"]') }).selectOption('openai-compatible');
    await page.getByPlaceholder('https://...').fill(stub.url);
    await page.getByText('Save').click();
    await page.getByRole('button', { name: 'Close', exact: true }).click();

    await page.getByLabel('Message Cascade').fill('explain at length');
    await page.getByLabel('Send').click();
    await expect(page.locator('[data-role="assistant"]').last()).toContainText('A long answer', { timeout: 20_000 });

    // The thread scrolls inside itself. The column around it neither overflows
    // nor moves, so the top bar stays at the top and the thread above the composer.
    // Sampled over two seconds: the overflow showed up once the reply's
    // receipt had been laid out, not at once.
    const main = page.locator('main');
    await expect(page.locator('[data-role="assistant"]').last().getByRole('button', { name: /\/why/ })).toBeVisible();
    for (let i = 0; i < 5; i++) {
      await page.waitForTimeout(400);
      expect(await main.evaluate((el) => ({ overflow: el.scrollHeight - el.clientHeight, top: el.scrollTop }))).toEqual({ overflow: 0, top: 0 });
    }
    expect((await main.locator('header').boundingBox())?.y).toBe(0);
    await expect(page.locator('[data-role="assistant"]').last()).toBeInViewport();

    // The account menu opens above its button; its gauges load after it opens
    // and make it taller, and it still ends on screen.
    await page.getByRole('button', { name: 'Account' }).click();
    const menu = page.getByRole('menu', { name: 'Account' });
    await expect(menu.getByText('Runs today', { exact: true })).toBeVisible();
    await expect(menu.getByText(/Tier mix/)).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('menuitem', { name: 'Settings' })).toBeInViewport({ ratio: 1 });
  } finally {
    await stub.close();
  }
});
