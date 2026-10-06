#!/usr/bin/env node
// ─────────────────────────────────────────────
//  Cascade AI — Browser vision test: the runner
// ─────────────────────────────────────────────
//
//  Decides tools.browserVision's default with evidence: the same tasks run
//  with each setting (off, list, image, marked) on the models you name, a few
//  times each, and the results side by side.
//
//    node scripts/browser-vision-eval/run.mjs --check
//        Solves every task with its scripted solution through browser_control,
//        no model involved. Free. Proves the site and the plumbing work.
//
//    node scripts/browser-vision-eval/run.mjs --models claude-sonnet-4-5,gpt-4o-mini
//        Prints what would run and roughly what it would cost. Spends nothing.
//
//    ... --models … --yes
//        Runs it. Uses your Cascade config (keys, providers) from the current
//        directory, with T1/T2/T3 all set to each model in turn.
//
//  Options: --arms off,list,image,marked  --repeats 3  --tasks saved,booking
//           --chromium <path>  --out results.md
//
//  Needs `npm run build:cli` first (it loads dist/) and Playwright's Chromium,
//  or --chromium pointing at one.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASKS } from './tasks.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const sdk = await import(path.join(here, '..', '..', 'dist', 'index.js'));

/** Rough cost of one task run, in input tokens, by setting — for the estimate only. */
const TOKENS_PER_RUN = { off: 40_000, list: 35_000, image: 50_000, marked: 50_000 };

const tasks = args.tasks ? TASKS.filter((t) => args.tasks.split(',').includes(t.id)) : TASKS;
const arms = (args.arms ?? 'off,list,image,marked').split(',');
const repeats = Number(args.repeats ?? 3);
const models = args.models ? args.models.split(',') : [];

if (!args.check && !models.length) {
  console.error('Give --check, or --models a,b,c to plan a run. See the header of this file.');
  process.exit(1);
}

// The plan and its estimate come first, before anything is started.
if (!args.check && !plan()) process.exit(0);

const site = await serveSite();
const chrome = await launchChromium(args.chromium);
try {
  if (args.check) await check();
  else await evaluate();
} finally {
  await chrome.kill();
  site.server.close();
}

// ── --check: the scripted solutions ──────────

async function check() {
  const controller = new sdk.RemoteBrowserController({ provider: new sdk.GenericCdpProvider(chrome.ws) });
  const tool = new sdk.BrowserControlTool(controller.controller, (a) => controller.actorEnded(a), controller.features);
  let failed = 0;
  for (const task of tasks) {
    const run = `check-${task.id}-${Date.now()}`;
    const options = { sessionId: run, tierId: 'check', requireApproval: false };
    const outputs = [];
    let labels = {};
    let viewText = '';
    const act = async (input) => {
      const out = await tool.execute(input, options);
      outputs.push(out);
      const view = out.indexOf('[Page view ');
      if (view !== -1) {
        viewText = out.slice(view);
        labels = Object.fromEntries([...viewText.matchAll(/^\[([a-z0-9]+)\] (.+?)(?: \(|: "|$)/gm)].map((m) => [m[1], m[2]]));
      }
      return out;
    };
    let problem = '';
    try {
      await act({ action: 'navigate', url: `${site.url}/${task.page}?run=${run}` });
      for (const step of task.solve) {
        const { label, after, scroll, ...input } = step;
        if (label) {
          let ref = findRef(viewText, labels, label, after);
          for (let i = 0; !ref && scroll && i < 12; i++) {
            await act({ action: 'scroll' });
            ref = findRef(viewText, labels, label, after);
          }
          if (!ref) { problem = `no ${label} in the page view`; break; }
          input.ref = ref;
        }
        const out = await act(input);
        if (out.startsWith('Failed') || out.startsWith('Error')) { problem = out.split('\n')[0]; break; }
      }
      await new Promise((r) => setTimeout(r, 300));
    } catch (err) {
      problem = String(err);
    }
    const ok = !problem && (task.check.done ? site.done.has(`${run}:${task.check.done}`) : task.check.answer.test(outputs.join('\n')));
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${task.id.padEnd(11)} ${task.tests}${problem ? `\n      ${problem}` : ''}`);
    await controller.endRun(run).catch(() => {});
  }
  await controller.dispose().catch(() => {});
  console.log(failed ? `\n${failed} of ${tasks.length} failed.` : `\nAll ${tasks.length} tasks can be done through browser_control.`);
  process.exitCode = failed ? 1 : 0;
}

/** The ref whose label matches, optionally the first one after another entry. */
function findRef(viewText, labels, label, after) {
  const lines = viewText.split('\n');
  let start = 0;
  if (after) {
    start = lines.findIndex((l) => l.includes(`] ${after}`));
    if (start === -1) return undefined;
  }
  for (const line of lines.slice(start)) {
    const m = /^\[([a-z0-9]+)\] /.exec(line);
    if (m && labels[m[1]] === label) return m[1];
  }
  return undefined;
}

// ── The model runs ───────────────────────────

/** Say what would run and roughly what it costs. True when it should go ahead. */
function plan() {
  const runs = tasks.length * arms.length * repeats * models.length;
  const tokens = tasks.length * repeats * models.length * arms.reduce((n, a) => n + (TOKENS_PER_RUN[a] ?? 50_000), 0);
  console.log(`${tasks.length} tasks × ${arms.length} settings (${arms.join(', ')}) × ${repeats} repeats × ${models.length} models = ${runs} runs.`);
  console.log(`Roughly ${(tokens / 1e6).toFixed(1)}M input tokens in all — about $${(tokens / 1e6 * 3).toFixed(0)} at $3 per million, more on dearer models.`);
  if (!args.yes) console.log('Nothing was run. Add --yes to run it.');
  return Boolean(args.yes);
}

async function evaluate() {
  const cm = new sdk.ConfigManager(process.cwd());
  await cm.load();
  const base = cm.getConfig();
  const controller = new sdk.RemoteBrowserController({ provider: new sdk.GenericCdpProvider(chrome.ws) });
  const steps = new Map();
  const counted = (action, context) => {
    steps.set(context.sessionId, (steps.get(context.sessionId) ?? 0) + 1);
    return controller.controller(action, context);
  };

  const rows = [];
  for (const model of models) {
    for (const arm of arms) {
      for (const task of tasks) {
        for (let r = 0; r < repeats; r++) {
          const run = `${model}-${arm}-${task.id}-${r}-${Date.now()}`.replace(/[^a-z0-9-]/gi, '');
          const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-bve-'));
          const config = {
            ...base,
            models: { ...base.models, t1: model, t2: model, t3: model },
            cascadeAuto: false,
            tools: { ...base.tools, remoteBrowser: { provider: 'cdp', url: chrome.ws }, browserVision: arm },
          };
          const cascade = new sdk.Cascade(config, workspace);
          const prompt = `Use the browser. Open ${site.url}/${task.page}?run=${run} and do this: ${task.prompt}`;
          const started = Date.now();
          let output = '';
          let error = '';
          let usage = {};
          let taskId = '';
          try {
            await cascade.init();
            cascade.setRemoteBrowserController(counted, (a) => controller.actorEnded(a), controller.features);
            const result = await cascade.run({ prompt, approvalCallback: async () => ({ approved: true, always: true }) });
            output = result.output;
            usage = result.usage ?? {};
            taskId = result.taskId;
          } catch (err) {
            error = err instanceof Error ? err.message : String(err);
          }
          const shots = cascade.getDecisionLog().find((d) => d.kind === 'browser')?.detail ?? '';
          const ok = task.check.done ? site.done.has(`${run}:${task.check.done}`) : task.check.answer.test(output);
          rows.push({
            model, arm, task: task.id, ok,
            steps: [...steps.entries()].filter(([k]) => k === taskId).reduce((n, [, v]) => n + v, 0),
            costUsd: usage.estimatedCostUsd ?? 0,
            tokens: usage.totalTokens ?? 0,
            seconds: Math.round((Date.now() - started) / 1000),
            shots, error,
          });
          console.log(`${ok ? 'PASS' : 'FAIL'}  ${model}  ${arm.padEnd(6)}  ${task.id.padEnd(11)}  $${(usage.estimatedCostUsd ?? 0).toFixed(4)}${error ? `  ${error}` : ''}`);
          if (taskId) await controller.endRun(taskId).catch(() => {});
          fs.rmSync(workspace, { recursive: true, force: true });
        }
      }
    }
  }
  await controller.dispose().catch(() => {});

  const out = args.out ?? 'browser-vision-eval-results.md';
  fs.writeFileSync(out, summarise(rows));
  fs.writeFileSync(out.replace(/\.md$/, '.json'), JSON.stringify(rows, null, 2));
  console.log(`\nWrote ${out}`);
}

function summarise(rows) {
  const lines = ['# Browser vision test', '', '| Model | Setting | Done | Steps (mean) | Cost (mean) | Tokens (mean) |', '|---|---|---|---|---|---|'];
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.model}|${r.arm}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const [key, rs] of groups) {
    const [model, arm] = key.split('|');
    const mean = (f) => rs.reduce((n, r) => n + f(r), 0) / rs.length;
    lines.push(`| ${model} | ${arm} | ${rs.filter((r) => r.ok).length}/${rs.length} | ${mean((r) => r.steps).toFixed(1)} | $${mean((r) => r.costUsd).toFixed(4)} | ${Math.round(mean((r) => r.tokens))} |`);
  }
  lines.push('', '## By task', '', '| Task | Model | Setting | Done |', '|---|---|---|---|');
  for (const t of tasks) {
    for (const [key, rs] of groups) {
      const [model, arm] = key.split('|');
      const mine = rs.filter((r) => r.task === t.id);
      lines.push(`| ${t.id} | ${model} | ${arm} | ${mine.filter((r) => r.ok).length}/${mine.length} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// ── The site, and a browser to drive it ──────

async function serveSite() {
  const done = new Set();
  const root = path.join(here, 'site');
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/done') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const { run, task } = JSON.parse(body);
          if (run && task) done.add(`${run}:${task}`);
        } catch { /* not ours */ }
        res.end();
      });
      return;
    }
    const file = path.join(root, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', types[path.extname(file)] ?? 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, done, url: `http://127.0.0.1:${server.address().port}` };
}

async function launchChromium(executable) {
  let binary = executable;
  if (!binary) {
    const { chromium } = await import('playwright');
    binary = chromium.executablePath();
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-bve-chrome-'));
  const child = spawn(binary, [
    '--headless=new', '--no-sandbox', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`, '--window-size=1280,800', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const ws = await new Promise((resolve, reject) => {
    let err = '';
    const timer = setTimeout(() => reject(new Error(`Chromium did not start: ${err.slice(-400)}`)), 15_000);
    child.stderr.on('data', (d) => {
      err += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Chromium exited (${code}): ${err.slice(-400)}`)); });
  });
  const kill = async () => {
    // Chromium keeps writing its profile until it has gone; removing it sooner
    // races that.
    const gone = new Promise((r) => child.once('exit', r));
    child.kill();
    await Promise.race([gone, new Promise((r) => setTimeout(r, 5_000))]);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { ws, kill };
}

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = list[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}
