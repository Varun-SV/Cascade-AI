// ─────────────────────────────────────────────
//  Cascade AI — The WebAssembly sandbox, inside its worker thread
// ─────────────────────────────────────────────
//
//  Runs one agent-written tool in QuickJS, compiled to WebAssembly, and
//  reports how it ended. The thread keeps the engine off the main one — a
//  loop in the guest stalls this thread, not Cascade — and gives the parent
//  something to terminate whatever the guest is doing. QuickJS is what
//  confines the code: its global object has the language and nothing else,
//  and the WebAssembly memory it runs in is all it can address. This file's
//  own Node globals stay out here with it, out of the guest's reach.
//
//  Built as its own self-contained bundle (tsup.config.ts), so it loads
//  where the backend has no node_modules. It imports packages only, never
//  this repository's modules: Node runs it from source in the tests.

import { parentPort, workerData } from 'node:worker_threads';
import {
  newQuickJSWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
} from 'quickjs-emscripten-core';

/** What the parent passes in. */
interface Job {
  code: string;
  /** The tool's input, as JSON. */
  input: string;
  /** When to give up, in ms since the epoch. */
  deadline: number;
  memoryLimitBytes: number;
}

/** What the parent answers to a host call. */
interface Answer {
  id: number;
  ok: boolean;
  text: string;
}

const STACK_LIMIT_BYTES = 1024 * 1024;

// Runs first, in the guest: takes the bridge and the code off the global
// object, and calls the code with the same (input, callTool, fetch, console)
// signature the other sandbox gives it. The code arrives as data and is
// compiled as a function body, never spliced into this source.
const GUEST_SRC = `(() => {
  const host = globalThis.__host;
  const code = globalThis.__code;
  const input = JSON.parse(globalThis.__input);
  delete globalThis.__host;
  delete globalThis.__code;
  delete globalThis.__input;
  const call = (kind, payload) =>
    host(kind, JSON.stringify(payload)).catch((reason) => { throw new Error(String(reason)); });
  const callTool = (name, toolInput) =>
    call('callTool', { name: String(name), input: toolInput == null ? {} : toolInput });
  const fetch = async (url, init) => {
    const safeInit = init && typeof init === 'object'
      ? { method: init.method, headers: init.headers, body: typeof init.body === 'string' ? init.body : undefined }
      : null;
    const r = JSON.parse(await call('fetch', { url: String(url), init: safeInit }));
    return {
      ok: r.ok, status: r.status, statusText: r.statusText,
      headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? r.contentType : null) },
      text: async () => r.body,
      json: async () => JSON.parse(r.body),
    };
  };
  const console = { log() {}, error() {} };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction('input', 'callTool', 'fetch', 'console', code);
  return fn(input, callTool, fetch, console).then((r) => String(r == null ? '' : r));
})()`;

const port = parentPort;
if (port) void run(port, workerData as Job);

async function run(port: NonNullable<typeof parentPort>, job: Job): Promise<void> {
  const done = (outcome: { kind: 'ok'; value: string } | { kind: 'error'; message: string } | { kind: 'timeout' }) => {
    port.postMessage({ kind: 'done', outcome });
  };

  // A literal specifier, so the bundler inlines it.
  const wasm = await newQuickJSWASMModuleFromVariant(import('@jitl/quickjs-singlefile-cjs-release-sync'));
  const runtime = wasm.newRuntime();
  runtime.setMemoryLimit(job.memoryLimitBytes);
  runtime.setMaxStackSize(STACK_LIMIT_BYTES);
  // Ends a loop that checks in; the parent terminates one that does not.
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(job.deadline));
  const ctx = runtime.newContext();

  /** How an error the guest raised, or its being interrupted, ends the run. */
  const fail = (handle: QuickJSHandle, from: QuickJSContext = ctx) => {
    const message = describe(from, handle);
    handle.dispose();
    done(Date.now() >= job.deadline || /\binterrupted\b/.test(message)
      ? { kind: 'timeout' }
      : { kind: 'error', message });
  };

  /** Run the guest's pending jobs: what continues once a host call answers. */
  const pump = () => {
    const jobs = runtime.executePendingJobs();
    if (jobs.error) fail(jobs.error, jobs.error.context);
  };

  let nextId = 0;
  const waiting = new Map<number, (answer: Answer) => void>();
  port.on('message', (answer: Answer) => {
    const settle = waiting.get(answer.id);
    waiting.delete(answer.id);
    settle?.(answer);
  });

  const hostFn = ctx.newFunction('__host', (kindHandle, payloadHandle) => {
    const id = nextId++;
    const deferred = ctx.newPromise();
    waiting.set(id, (answer) => {
      const value = ctx.newString(answer.text);
      if (answer.ok) deferred.resolve(value); else deferred.reject(value);
      value.dispose();
      pump();
    });
    port.postMessage({
      kind: 'call',
      id,
      call: String(ctx.dump(kindHandle)),
      payload: String(ctx.dump(payloadHandle)),
    });
    return deferred.handle;
  });
  ctx.setProp(ctx.global, '__host', hostFn);
  hostFn.dispose();
  setString(ctx, '__code', job.code);
  setString(ctx, '__input', job.input);

  const started = ctx.evalCode(GUEST_SRC, 'dynamic-tool.js');
  if (started.error) {
    fail(started.error);
    return;
  }
  const result = started.value;
  void ctx.resolvePromise(result).then((settled) => {
    if (settled.error) {
      fail(settled.error);
      return;
    }
    const value = ctx.getString(settled.value);
    settled.value.dispose();
    done({ kind: 'ok', value });
  });
  result.dispose();
  pump();
}

function setString(ctx: QuickJSContext, name: string, value: string): void {
  const handle = ctx.newString(value);
  ctx.setProp(ctx.global, name, handle);
  handle.dispose();
}

/** A guest error as one line: its name and message, or whatever was thrown. */
function describe(ctx: QuickJSContext, handle: QuickJSHandle): string {
  try {
    const dumped: unknown = ctx.dump(handle);
    if (dumped && typeof dumped === 'object' && 'message' in dumped) {
      const { name, message } = dumped as { name?: unknown; message?: unknown };
      return name ? `${String(name)}: ${String(message)}` : String(message);
    }
    return String(dumped);
  } catch {
    return 'unknown error';
  }
}
