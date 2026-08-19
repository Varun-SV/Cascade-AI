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

export interface StubOpenAIOptions {
  /**
   * Hold the completion open this long before writing any chunk. Lets a test
   * act while a run is genuinely in flight (disconnect, abort, stop) instead
   * of racing an instant response. Default 0 — every existing caller is
   * unchanged.
   */
  delayMs?: number;
  /**
   * Fail the completion with a 500 after `delayMs` instead of answering.
   *
   * Lets a test drive the path where a run creates its conversation and THEN
   * dies — the case where the terminal event is `session:error` rather than
   * `session:complete`, and where a disconnected client would otherwise learn
   * nothing about why its answer never came.
   */
  failCompletion?: boolean;
}

export function startStubOpenAIServer(options: StubOpenAIOptions = {}): Promise<StubOpenAIServer> {
  const delayMs = options.delayMs ?? 0;
  const failCompletion = options.failCompletion ?? false;
  const requestLog: string[] = [];
  const server = http.createServer((req, res) => {
    requestLog.push(`${req.method} ${req.url}`);

    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
      return;
    }

    if (req.method === 'POST' && req.url?.endsWith('/chat/completions') && failCompletion) {
      const fail = () => {
        if (res.writableEnded || res.destroyed) return;
        // 400 rather than 500 on purpose: a 5xx is retried, and a test that
        // wants the run to DIE should not be racing a backoff schedule.
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'stub provider failure', type: 'invalid_request_error' } }));
      };
      if (delayMs > 0) {
        const timer = setTimeout(fail, delayMs);
        res.on('close', () => clearTimeout(timer));
      } else {
        fail();
      }
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

      const finish = () => {
        // The client may already be gone (an aborted run destroys the socket);
        // writing to a closed response would throw out of a timer callback.
        if (res.writableEnded || res.destroyed) return;
        res.write(chunk({ role: 'assistant', content: 'Hello ' }));
        res.write(chunk({ content: 'from the stub model.' }));
        res.write(chunk({}, 'stop'));
        res.write(`data: ${JSON.stringify({
          id, object: 'chat.completion.chunk', created, model: 'stub-model',
          choices: [], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      };
      if (delayMs > 0) {
        const timer = setTimeout(finish, delayMs);
        res.on('close', () => clearTimeout(timer));
      } else {
        finish();
      }
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
