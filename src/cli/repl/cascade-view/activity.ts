// ─────────────────────────────────────────────
//  Cascade AI — What each node of the cascade is doing
// ─────────────────────────────────────────────
//
//  The live view shows, for the node you select (or the busiest one), its
//  latest thought and its tool calls as they happen:
//
//    ∙ routes first, then the templates…
//    ▸ file_write  src/api.py        +84 −0
//    ▸ shell       pytest -q         ✔ 12 passed
//    ◐ file_write  templates/index.html
//
//  Built from the run's own events (tool:call, tool:result, tier:thinking,
//  tier:status). Nothing here is sent anywhere: it is what this terminal draws.

import type { PeerMessageEvent } from '../../../types.js';

export interface Activity {
  id: string;
  tool: string;
  /** What it acted on: a path, a command, a URL. */
  target: string;
  state: 'running' | 'ok' | 'failed';
  /** After it ended: "+84 −2", "✔ 12 passed", "exit 1"… */
  note?: string;
}

export interface NodeActivity {
  startedAt?: number;
  /** When it last did something: a call, a result, a thought. */
  lastAt?: number;
  endedAt?: number;
  /** The last line of the node's latest thinking. */
  thought?: string;
  items: Activity[];
}

interface ToolCall { id: string; tierId: string; toolName: string; input?: Record<string, unknown> }
interface ToolResult { id: string; tierId: string; toolName: string; output?: string; error?: string }
interface Thinking { tierId: string; call?: number; text?: string; done?: boolean }

const KEEP = 40;

/** One run's activity, by node id. Mutable: the REPL redraws on a counter it bumps. */
export class ActivityLog {
  private nodes = new Map<string, NodeActivity>();
  private inputs = new Map<string, Record<string, unknown>>();
  private thinking = new Map<string, { call: number; text: string }>();

  clear(): void { this.nodes.clear(); this.inputs.clear(); this.thinking.clear(); }

  get(id: string): NodeActivity | undefined { return this.nodes.get(id); }

  private node(id: string): NodeActivity {
    let n = this.nodes.get(id);
    if (!n) { n = { items: [] }; this.nodes.set(id, n); }
    return n;
  }

  status(id: string, status: string, now = Date.now()): void {
    const n = this.node(id);
    if (status === 'ACTIVE') { n.startedAt ??= now; n.endedAt = undefined; }
    if ((status === 'COMPLETED' || status === 'FAILED' || status === 'BLOCKED') && n.startedAt !== undefined) n.endedAt ??= now;
  }

  toolCall(ev: ToolCall, now = Date.now()): void {
    const n = this.node(ev.tierId);
    n.startedAt ??= now;
    n.lastAt = now;
    const input = ev.input ?? {};
    this.inputs.set(ev.id, input);
    n.items.push({ id: ev.id, tool: ev.toolName, target: toolTarget(ev.toolName, input), state: 'running' });
    if (n.items.length > KEEP) n.items.splice(0, n.items.length - KEEP);
  }

  toolResult(ev: ToolResult, now = Date.now()): void {
    const n = this.node(ev.tierId);
    n.lastAt = now;
    const item = [...n.items].reverse().find((i) => i.id === ev.id);
    if (!item) return;
    const failed = Boolean(ev.error) || /^(exit [1-9]|error|tool .* was (denied|not run))/i.test(ev.output ?? '');
    item.state = failed ? 'failed' : 'ok';
    const note = toolNote(ev.toolName, this.inputs.get(ev.id) ?? {}, ev.output ?? '', ev.error);
    if (note) item.note = note;
    this.inputs.delete(ev.id);
  }

  think(ev: Thinking, now = Date.now()): void {
    if (!ev.text) return;
    this.node(ev.tierId).lastAt = now;
    const call = ev.call ?? 0;
    const prev = this.thinking.get(ev.tierId);
    // A finished call carries all of its thinking, replacing what streamed.
    const text = ev.done || !prev || prev.call !== call ? ev.text : prev.text + ev.text;
    this.thinking.set(ev.tierId, { call, text: text.slice(-2000) });
    const line = lastLine(text);
    if (line) this.node(ev.tierId).thought = line;
  }
}

function lastLine(text: string): string {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter((l) => l.length > 2);
  const last = lines.at(-1) ?? '';
  return last.length > 160 ? `…${last.slice(-159)}` : last;
}

const s = (v: unknown): string => (typeof v === 'string' ? v : '');

/** What a call acts on, in a few words. */
export function toolTarget(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'shell': return s(input['command']).replace(/\s+/g, ' ').trim();
    case 'run_code': return `${s(input['language']) || 'code'}: ${s(input['code']).split('\n')[0] ?? ''}`.trim();
    case 'git': return `${s(input['operation'])} ${Array.isArray(input['args']) ? (input['args'] as unknown[]).map(String).join(' ') : ''}`.trim();
    case 'web_search': return s(input['query']);
    case 'web_fetch': case 'browser': case 'browser_control': return s(input['url']) || `${s(input['action'])} ${s(input['selector'] ?? input['ref'])}`.trim();
    default: return s(input['path']) || s(input['file']) || s(input['query']) || s(input['url']) || s(input['name']) || '';
  }
}

const lines = (text: string): number => (text ? text.split('\n').length : 0);

/** What came of a call, in a few characters. */
export function toolNote(tool: string, input: Record<string, unknown>, output: string, error?: string): string | undefined {
  if (error) return oneLine(error, 40);
  switch (tool) {
    case 'file_write': return `+${lines(s(input['content']))} −0`;
    case 'file_edit': {
      const oldText = s(input['old_string'] ?? input['oldText'] ?? input['search']);
      const newText = s(input['new_string'] ?? input['newText'] ?? input['replace']);
      return oldText || newText ? `+${lines(newText)} −${lines(oldText)}` : undefined;
    }
    case 'shell': case 'run_code': {
      const tests = testSummary(output);
      if (tests) return tests;
      const exit = /^Exit (\d+):/.exec(output);
      if (exit) return `exit ${exit[1]}`;
      if (/\[stopped after \d+s: it timed out/.test(output)) return 'timed out';
      return undefined;
    }
    default: return undefined;
  }
}

/** "12 passed", "3 failed, 9 passed" from the usual test runners' summaries. */
export function testSummary(output: string): string | undefined {
  const tail = output.slice(-4000);
  const failed = /(\d+) (?:failed|failing)/i.exec(tail)?.[1];
  const passed = /(\d+) (?:passed|passing)/i.exec(tail)?.[1] ?? /Tests:\s+(\d+) passed/i.exec(tail)?.[1] ?? /ok \((\d+) tests?\)/i.exec(tail)?.[1];
  if (!failed && !passed) return /\bRan (\d+) tests?\b[\s\S]*\bOK\b/.test(tail) ? `${/\bRan (\d+) tests?/.exec(tail)![1]} passed` : undefined;
  return [failed && Number(failed) > 0 ? `${failed} failed` : '', passed ? `${passed} passed` : ''].filter(Boolean).join(', ') || undefined;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A comms event, said the way a person would: "T3·db released src/db.py". */
export function commsLine(ev: PeerMessageEvent, nameOf: (id: string) => string): string {
  const from = nameOf(ev.fromId);
  const to = ev.toId ? nameOf(ev.toId) : 'everyone';
  const said = oneLine(ev.payload ?? '', 70);
  switch (ev.syncType) {
    case 'COORDINATION': return `${from} ${said || 'coordinated'}`;
    case 'SHARE_OUTPUT': return `${from} shared its result with ${to}${said ? `: ${said}` : ''}`;
    case 'DIVIDE_WORK': return `${from} split the work with ${to}${said ? `: ${said}` : ''}`;
    case 'CHECK_ASSUMPTION': return `${from} asked ${to}${said ? `: ${said}` : ''}`;
    case 'RESOLVE_CONFLICT': return `${from} and ${to} settled a clash${said ? `: ${said}` : ''}`;
    case 'SIGNAL_READY': return `${from} is ready${ev.toId ? ` for ${to}` : ''}`;
    case 'TOOL_CREATED': return `${from} made a tool${said ? `: ${said}` : ''}`;
    default: return `${from} → ${to}${said ? `: ${said}` : ''}`;
  }
}

/** "1:12", "0:41", "12:05" */
export function clock(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
