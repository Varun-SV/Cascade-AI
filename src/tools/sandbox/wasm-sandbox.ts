// ─────────────────────────────────────────────
//  Cascade AI — The WebAssembly sandbox for agent-written tools
// ─────────────────────────────────────────────
//
//  A tool the agent writes for itself runs here unless the optional
//  `isolated-vm` addon loads. It used to run in a bare worker thread
//  instead, which bounds time and memory but confines nothing: the code saw
//  `process`, and through it the files, the network and the processes of
//  the machine. The desktop app never ships the addon, so there that was
//  every run.
//
//  The engine is QuickJS compiled to WebAssembly (wasm-sandbox-worker.ts),
//  in a worker thread of its own. QuickJS confines the code: its global
//  object has the language and nothing else — no `process`, no `require`,
//  no timers, no network. The thread keeps a runaway guest off the main
//  one, and is terminated whole at the deadline, whatever the guest is in
//  the middle of. The code reaches the host through exactly two bridges,
//  `callTool` and `fetch`, answered here by functions the caller supplies
//  already gated. A fresh thread and engine serve each run, so nothing one
//  run leaves behind reaches the next.
//
//  There is no fallback to anything weaker: if the engine cannot start,
//  the tool does not run.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

/** What the guest may ask of the host. Both are gated by the caller. */
export interface SandboxHost {
  /** Run a registered tool; its result, or why it did not run, as text. */
  callTool(name: string, input: Record<string, unknown>): Promise<string>;
  /** Fetch a URL; the JSON the guest's response is built from. Throws to fail it. */
  fetch(url: string, init: unknown): Promise<string>;
}

export type SandboxOutcome =
  | { kind: 'ok'; value: string }
  | { kind: 'error'; message: string }
  | { kind: 'timeout' };

export interface SandboxLimits {
  /** Wall-clock budget for the whole run, host calls included. */
  timeoutMs: number;
  memoryLimitBytes?: number;
}

const DEFAULT_MEMORY_LIMIT_BYTES = 128 * 1024 * 1024;

/**
 * The worker's file: the bundle beside this one once built, the source
 * beside this one in the tests. Undefined when neither is there.
 */
export function sandboxWorkerFile(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return ['wasm-sandbox-worker.cjs', 'wasm-sandbox-worker.ts']
    .map((name) => path.join(here, name))
    .find((file) => existsSync(file));
}

/**
 * Run `code`, an async function body, on `input` inside a fresh QuickJS
 * WebAssembly engine on its own thread, with `host` as its only way out.
 */
export function runInWasmSandbox(
  code: string,
  input: Record<string, unknown>,
  host: SandboxHost,
  limits: SandboxLimits,
): Promise<SandboxOutcome> {
  const file = sandboxWorkerFile();
  if (!file) {
    return Promise.resolve({
      kind: 'error',
      message: 'the WebAssembly sandbox is missing from this install (wasm-sandbox-worker), so the tool was not run',
    });
  }

  return new Promise<SandboxOutcome>((resolve) => {
    let done = false;
    const worker = new Worker(file, {
      workerData: {
        code,
        input: JSON.stringify(input ?? {}),
        deadline: Date.now() + limits.timeoutMs,
        memoryLimitBytes: limits.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES,
      },
      // The guest's memory is the engine's, capped above; this caps the
      // thread's own JavaScript around it.
      resourceLimits: { maxOldGenerationSizeMb: 64 },
      // Not the terminal's: the guest has no console, and nothing the engine
      // prints belongs in the middle of Cascade's own output.
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();

    const finish = (outcome: SandboxOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(outcome);
    };

    // The engine ends a guest loop at the deadline itself; this ends one it
    // cannot reach — a long native call — and a wait on the host.
    const timer = setTimeout(() => finish({ kind: 'timeout' }), limits.timeoutMs);
    timer.unref?.();

    worker.on('message', (msg: { kind?: string; id?: number; call?: string; payload?: string; outcome?: SandboxOutcome }) => {
      if (msg?.kind === 'done' && msg.outcome) {
        finish(msg.outcome);
      } else if (msg?.kind === 'call') {
        serve(host, String(msg.call), String(msg.payload)).then(
          (text) => { if (!done) worker.postMessage({ id: msg.id, ok: true, text }); },
          (err: unknown) => {
            if (!done) worker.postMessage({ id: msg.id, ok: false, text: err instanceof Error ? err.message : String(err) });
          },
        );
      }
    });
    worker.on('error', (err) => finish({ kind: 'error', message: err instanceof Error ? err.message : String(err) }));
    worker.on('exit', (code) => finish({ kind: 'error', message: `the sandbox exited unexpectedly (code ${code})` }));
  });
}

async function serve(host: SandboxHost, call: string, payload: string): Promise<string> {
  const request = parseObject(payload);
  if (call === 'callTool') {
    const toolInput = request['input'];
    return host.callTool(
      String(request['name']),
      toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)
        ? (toolInput as Record<string, unknown>)
        : {},
    );
  }
  if (call === 'fetch') return host.fetch(String(request['url']), request['init']);
  throw new Error(`Unknown host call: ${call}`);
}

function parseObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
