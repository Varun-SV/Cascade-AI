// ─────────────────────────────────────────────
//  Cascade AI — Shell Tool
// ─────────────────────────────────────────────

import { type ChildProcess, type SpawnOptions, execFile, spawn } from 'node:child_process';
import type { ToolExecuteOptions } from '../types.js';
import { BaseTool } from './base.js';

export interface Ran { stdout: string; stderr: string; code: number; timedOut: boolean }

/**
 * Runs a command in a process group of its own, so that a console Ctrl-C
 * event it raises (on Windows, one goes to every process on the console)
 * never reaches Cascade: one did, and Cascade quit in the middle of a run.
 * On a timeout or a cancelled run the whole tree is stopped, not just the
 * shell, so a server it started doesn't stay behind holding its port.
 */
export function runInOwnGroup(
  spec: { command: string } | { file: string; args: string[] },
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeout: number; signal?: AbortSignal },
): Promise<Ran> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let cancelled = false;
    let overflowed = false;
    // stdin closed: a command that waits for input gets end-of-input at once,
    // rather than hanging until its timeout. Output piped, never inherited.
    const common: SpawnOptions = { cwd: opts.cwd, windowsHide: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'], ...(opts.env ? { env: opts.env } : {}) };
    const child = 'command' in spec ? spawn(spec.command, { ...common, shell: true }) : spawn(spec.file, spec.args, common);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    const collect = (into: Buffer[]) => (chunk: Buffer): void => {
      if (overflowed) return;
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) { overflowed = true; stopTree(child); return; }
      into.push(chunk);
    };
    child.stdout?.on('data', collect(out));
    child.stderr?.on('data', collect(err));
    const timer = setTimeout(() => { timedOut = true; stopTree(child); }, opts.timeout);
    const onAbort = (): void => { cancelled = true; stopTree(child); };
    const finish = (code: number | null, failure?: Error): void => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (cancelled) {
        const stopped = new Error('The command was stopped: the run was cancelled.');
        stopped.name = 'AbortError';
        reject(stopped);
        return;
      }
      if (failure) { reject(failure); return; }
      const stderr = Buffer.concat(err).toString('utf8') + (overflowed ? `\n[output passed ${MAX_OUTPUT_BYTES / 1024 / 1024} MB; the command was stopped]` : '');
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr, code: code ?? 1, timedOut });
    };
    child.on('error', (e) => finish(null, e));
    child.on('close', (code) => finish(code));
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Output kept from a command, stdout and stderr together, as exec's default allowed. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Stops a command and everything it started. */
export function stopTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => { /* gone already */ });
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { /* gone already */ }
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

/**
 * A command that would stop Cascade itself: by its program's name (Cascade
 * runs as node), or by its own or its parent's process id. A run cleaning up
 * a dev server with `taskkill /IM node.exe /F` ended the session in silence.
 */
export function stopsCascade(command: string, pids: number[] = [process.pid, process.ppid]): boolean {
  const c = command.toLowerCase();
  const byName = [
    /\btaskkill\b[^|;&]*\/im\s+["']?(?:node|cascade)(?:\.exe)?["']?(?:\s|$)/,
    /\b(?:stop-process|spps|kill)\b[^|;&]*-(?:processname|name)\s+["']?(?:node|cascade)["']?(?:\s|$|,)/,
    /\b(?:pkill|killall)\b(?:\s+-[\w-]+(?:\s+\S+)?)*\s+["']?(?:node|nodejs|cascade)["']?(?:\s|$)/,
    /\bwmic\b[^|;&]*name\s*=\s*['"]?(?:node|cascade)(?:\.exe)?['"]?[^|;&]*\b(?:delete|terminate)\b/,
    /\bget-process\b[^|;&]*\b(?:node|cascade)\b[^;&]*\|\s*(?:stop-process|spps|kill)\b/,
  ];
  if (byName.some((p) => p.test(c))) return true;
  const ids = pids.filter((p) => Number.isInteger(p) && p > 1).map(String);
  if (!ids.length) return false;
  const pidRe = new RegExp(`(?:\\b(?:kill|taskkill|stop-process|spps)\\b[^|;&]*?)(?:/pid\\s+|-id\\s+|-\\w+\\s+|\\s)(${ids.join('|')})(?:\\s|$|,)`);
  return pidRe.test(c);
}

export class ShellTool extends BaseTool {
  readonly name = 'shell';
  readonly description = 'Execute a shell command and return its output. Use for running scripts, compiling code, running tests, etc.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      cwd: { type: 'string', description: 'Working directory (optional)' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' },
    },
    required: ['command'],
  };

  private allowlist: string[];
  private blocklist: string[];

  constructor(allowlist: string[] = [], blocklist: string[] = []) {
    super();
    this.allowlist = allowlist;
    this.blocklist = blocklist;
  }

  isDangerous(): boolean {
    return true;
  }

  async execute(input: Record<string, unknown>, options: ToolExecuteOptions): Promise<string> {
    const command = input['command'] as string;
    const cwd = (input['cwd'] as string | undefined) ?? this.workspaceRoot;
    const timeout = (input['timeout'] as number | undefined) ?? 30_000;

    this.validateCommand(command);

    // `sh -c` is what exec runs on POSIX; spelled out, it can be launched in
    // the jail. Windows has no jail, and keeps exec with a scrubbed environment.
    const posix = process.platform !== 'win32';
    const prepared = this.jail
      ? await this.jail.prepare(posix ? '/bin/sh' : command, posix ? ['-c', command] : [], { cwd, offline: options.isOffline?.() === true })
      : undefined;
    if (prepared && !prepared.ok) throw new Error(prepared.reason);
    const launch = prepared?.launch;

    let output: string;
    let note: string | void;
    try {
      // windowsHide: prevent a console window flash per command on Windows.
      // Output is piped, never inherited — it cannot write over the live TUI.
      const ran = launch && posix
        ? await runInOwnGroup({ file: launch.file, args: launch.args }, { cwd: launch.cwd, env: launch.env, timeout, ...(options.signal ? { signal: options.signal } : {}) })
        : await runInOwnGroup({ command }, { cwd, timeout, ...(launch ? { env: launch.env } : {}), ...(options.signal ? { signal: options.signal } : {}) });
      const text = [ran.stdout, ran.stderr].filter(Boolean).join('\n').trim();
      output = ran.code === 0 && !ran.timedOut ? text || '(no output)' : `Exit ${ran.code}:\n${text}`;
      if (ran.timedOut) output += `\n[stopped after ${Math.round(timeout / 1000)}s: it timed out, and the command and everything it started were stopped]`;
    } finally {
      note = await launch?.done?.();
    }
    return note ? `${output}\n\n[note] ${note}` : output;
  }

  private validateCommand(command: string): void {
    // Block obviously catastrophic patterns. This is defense-in-depth only —
    // a blocklist can never be exhaustive; the approval prompt is the real
    // gate. Patterns tolerate flag reordering and extra whitespace so trivial
    // variants like `rm  -fr  /` don't slip through.
    const builtinDangerous = [
      /\brm\s+(?:-\w+\s+)*-\w*[rf]\w*[rf]\w*\s+(?:\/|~|\$HOME)(?:\s|$)/, // rm -rf / , rm -fr ~
      />\s*\/dev\/[sh]d[a-z]/,
      /\bmkfs[.\s]/,
      /\bdd\s+.*\bof=\/dev\/[sh]d[a-z]/,
      /\bchmod\s+(?:-\w+\s+)*-?R?\s*777\s+\//,
      /:\(\)\s*\{\s*:\s*\|\s*:?\s*&\s*\}\s*;/, // fork bomb :(){ :|:& };:
    ];

    for (const pattern of builtinDangerous) {
      if (pattern.test(command)) {
        throw new Error(`Command blocked: matches dangerous pattern`);
      }
    }
    if (stopsCascade(command)) {
      throw new Error(`Command refused: it would stop Cascade itself, which runs as node (process ${process.pid}). Stop the program you mean by its own process id, or by the port it listens on.`);
    }

    // User blocklist (substring match)
    for (const blocked of this.blocklist) {
      if (command.toLowerCase().includes(blocked.toLowerCase())) {
        throw new Error(`Command blocked by blocklist: "${blocked}"`);
      }
    }

    // User allowlist (if set, the FIRST token of the command must be an exact
    // match for an entry, and the command must contain no shell metacharacters).
    //
    // Previously this used `command.startsWith(a)`, which let `npm-foo` through
    // when `npm` was whitelisted. Token-level comparison closes that hole.
    if (this.allowlist.length > 0) {
      const firstToken = command.trimStart().split(/\s+/)[0] ?? '';
      const allowed = this.allowlist.some((a) => firstToken === a);
      if (!allowed) {
        throw new Error(
          `Command not in allowlist. First token "${firstToken}" must exactly ` +
          `match one of: ${this.allowlist.join(', ')}`,
        );
      }

      // Chaining metacharacters defeat the allowlist — block them when allowlist is active.
      const SHELL_METACHAR = /[;|`]|\$\(|&&|\|\|/;
      if (SHELL_METACHAR.test(command)) {
        throw new Error(
          `Command blocked: shell metacharacters (;, |, &&, ||, \`, $(...)) are not permitted ` +
          `when an allowlist is active because they allow chaining of arbitrary commands.`,
        );
      }
    }
  }
}
