import { test, expect, type Page } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// An OpenAI-compatible stub that reports its token usage, so the run has
// something to put in the spend ledger. It has no published price, so the
// report shows its tokens and "no price".
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
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'stub-model', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
      res.write(chunk({ role: 'assistant', content: 'Hello from the spend stub.' }));
      res.write(chunk({}, 'stop'));
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'stub-model', choices: [], usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 } })}\n\n`);
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

async function signInWithKey(page: Page, url: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByPlaceholder('Your name').fill(`Spender ${Date.now()}`);
  await page.getByText('Dev login').click();
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'API keys' }).click();
  await page.getByText('Add provider').click();
  await page.locator('select').filter({ has: page.locator('option[value="openai-compatible"]') }).selectOption('openai-compatible');
  await page.getByPlaceholder('https://...').fill(url);
  await page.getByText('Save').click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
}

test('a run lands in the spend report, reached from the account menu and from /why', async ({ page }) => {
  const stub = await startStubLLM();
  try {
    await signInWithKey(page, stub.url);
    await page.getByPlaceholder('Ask Cascade anything').fill('hello there');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Hello from the spend stub.')).toBeVisible({ timeout: 20_000 });

    // From the account menu.
    await page.getByRole('button', { name: 'Account' }).click();
    await page.getByRole('menuitem', { name: 'Spend & savings' }).click();
    const report = page.getByRole('dialog', { name: 'Spend & savings' });
    await expect(report).toBeVisible();
    await expect(report.getByText('52 tokens')).toBeVisible();
    // The stub has no published price: its tokens show, marked "no price".
    const tier = report.getByRole('button', { name: /T\d · / }).first();
    await tier.click();
    await expect(report.getByText('no price').first()).toBeVisible();
    await expect(report.getByText(/stub-model/).first()).toBeVisible();

    await report.getByRole('button', { name: 'Today' }).click();
    await expect(report.getByText('Spent and saved by hour')).toBeVisible();
    await page.screenshot({ path: process.env.SPEND_SHOTS ? `${process.env.SPEND_SHOTS}/report-today.png` : undefined, fullPage: false });

    // A chat in the list opens it and closes the report.
    await report.getByRole('button', { name: /hello there/ }).click();
    await expect(report).toBeHidden();
    await expect(page.getByText('Hello from the spend stub.')).toBeVisible();

    // From the reply's /why.
    await page.getByRole('button', { name: /\/why/ }).first().click();
    await page.getByRole('button', { name: /All spending and savings/ }).click();
    await expect(page.getByRole('dialog', { name: 'Spend & savings' })).toBeVisible();
    await page.getByRole('dialog', { name: 'Spend & savings' }).getByRole('button', { name: 'Close' }).click();
  } finally {
    await stub.close();
  }
});
