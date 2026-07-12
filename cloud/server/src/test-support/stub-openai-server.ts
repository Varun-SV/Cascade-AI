// Minimal OpenAI-compatible endpoint for tests: GET /models for provider
// discovery, POST /chat/completions (SSE) for generation. Lets integration
// tests exercise the real OpenAICompatibleProvider HTTP client without a
// real API key or network access.

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StubOpenAIServer {
  url: string;
  requestLog: string[];
  close: () => Promise<void>;
}

export function startStubOpenAIServer(): Promise<StubOpenAIServer> {
  const requestLog: string[] = [];
  const server = http.createServer((req, res) => {
    requestLog.push(`${req.method} ${req.url}`);

    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
      return;
    }

    if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const id = 'chatcmpl-stub';
      const created = Math.floor(Date.now() / 1000);
      const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
        `data: ${JSON.stringify({
          id, object: 'chat.completion.chunk', created, model: 'stub-model',
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`;

      res.write(chunk({ role: 'assistant', content: 'Hello ' }));
      res.write(chunk({ content: 'from the stub model.' }));
      res.write(chunk({}, 'stop'));
      res.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created, model: 'stub-model',
        choices: [], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
      })}\n\n`);
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
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        requestLog,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
