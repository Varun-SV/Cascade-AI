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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TASKS } from './tasks.mjs';
import { answeredExactly, assessRun, modelBindingsMatch, pageShows, pictureMissed, scheduleRuns, summarise } from './results.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
// A file URL, not a path: on Windows an absolute path is not something import() takes.
const sdk = await import(pathToFileURL(path.join(here, '..', '..', 'dist', 'index.js')).href);

/**
 * A run that would not have tested the browser alone. Ends the whole test.
 * Up here because a class, unlike a function, exists only from its line on.
 */
class IsolationError extends Error {}

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
    const ok = !problem && (task.check.done ? site.done.has(`${run}:${task.check.done}`) : pageShows(task.check.answer, outputs.join('\n')));
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
  // Steps that showed the page without the picture asked for: withheld by the
  // browser, or never taken because no page view could be built. Neither
  // reaches the router, so its counts cannot show them.
  const withheld = new Map();
  const counted = async (action, context) => {
    steps.set(context.sessionId, (steps.get(context.sessionId) ?? 0) + 1);
    const outcome = await controller.controller(action, context);
    if (pictureMissed(action, outcome)) withheld.set(context.sessionId, (withheld.get(context.sessionId) ?? 0) + 1);
    return outcome;
  };

  // The browser and nothing else. `enabledTools: []` keeps out the built-in
  // tools, but generation tools (images, speech, documents) register outside
  // that list wherever your config can reach their APIs. They are found here,
  // once, and named in `disabledTools` for every run — and each run checks
  // that browser_control is all it was given.
  const isolated = (model, arm, disabled) => ({
    ...base,
    models: { ...base.models, t1: model, t2: model, t3: model },
    cascadeAuto: false,
    enableToolCreation: false,
    // These two register their tools as a run starts, outside both lists.
    plugins: [],
    codeIndex: { ...base.codeIndex, enabled: false },
    tools: {
      ...base.tools,
      enabledTools: [],
      disabledTools: disabled,
      mcpServers: [],
      remoteBrowser: { provider: 'cdp', url: chrome.ws },
      browserVision: arm,
    },
  });
  // They register as a Cascade is built, so building one is enough: nothing
  // is initialised, and a model that cannot be reached is each run's to report.
  const inheritedDisabled = (base.tools?.disabledTools ?? []).filter((name) => name !== 'browser_control');
  const probeSpace = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-bve-'));
  const probe = new sdk.Cascade(isolated(models[0], arms[0], inheritedDisabled), probeSpace);
  const disabled = [
    ...inheritedDisabled,
    ...probe.getToolRegistry().getToolDefinitions().map((d) => d.name).filter((n) => n !== 'browser_control'),
  ];
  await probe.close();
  fs.rmSync(probeSpace, { recursive: true, force: true });

  const rows = [];
  for (const { model, arm, task, repeat: r } of scheduleRuns(models, arms, tasks, repeats)) {
    const run = `${model}-${arm}-${task.id}-${r}-${Date.now()}`.replace(/[^a-z0-9-]/gi, '');
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-bve-'));
    // The browser and nothing else. The model reads pages this test
    // wrote, but it is still a model reading web pages, and your own
    // config would otherwise hand it your shell, files and MCP servers.
    const cascade = new sdk.Cascade(isolated(model, arm, disabled), workspace);
    // Track session ownership across every exit path, including errors.
    const known = new Set(steps.keys());
    try {
      const prompt = `Use the browser. Open ${site.url}/${task.page}?run=${run} and do this: ${task.prompt}`;
      const started = Date.now();
      let output = '';
      let error = '';
      let usage = {};
      let modelInvalid = '';
      // The runs this one opened in the browser, whether or not it returns:
      // a run that throws must still give its session back, or every run
      // after it finds the one CDP session taken.
      try {
        await cascade.init();
        const bindings = ['T1', 'T2', 'T3'].map((tier) => cascade.getRouter().getModelForTier(tier));
        if (!modelBindingsMatch(model, bindings)) {
          modelInvalid = 'The requested model was not bound to every tier; this run is excluded from the comparison.';
          throw new Error(modelInvalid);
        }
        cascade.setRemoteBrowserController(counted, (a) => controller.actorEnded(a), controller.features);
        const offered = cascade.getToolRegistry().getToolDefinitions().map((d) => d.name);
        if (offered.length !== 1 || offered[0] !== 'browser_control') {
          throw new IsolationError(`Expected only browser_control, but this run would offer: ${offered.join(', ') || '(none)'}.`);
        }
        const result = await cascade.run({
          prompt,
          approvalCallback: async (request) => ({ approved: request.toolName === 'browser_control', always: false }),
        });
        output = result.output;
        usage = result.usage ?? {};
      } catch (err) {
        // Not a result: the comparison would not be of the browser alone.
        if (err instanceof IsolationError) throw err;
        error = err instanceof Error ? err.message : String(err);
      }
      const opened = [...steps.keys()].filter((k) => !known.has(k));
      const decisions = cascade.getDecisionLog();
      const shots = decisions.find((d) => d.kind === 'browser')?.detail ?? '';
      // The page reports a finished task with a request of its own, which
      // can land after the model's last word: wait for it a moment.
      if (task.check.done) await reported(`${run}:${task.check.done}`);
      const ok = task.check.done ? site.done.has(`${run}:${task.check.done}`) : answeredExactly(task.check.answer, output);
      const stepCount = opened.reduce((n, k) => n + (steps.get(k) ?? 0), 0);
      const withheldCount = opened.reduce((n, k) => n + (withheld.get(k) ?? 0), 0);
      const assessment = assessRun({
        ok, usage, stats: cascade.getRouter().getStats(), decisions, error, modelInvalid,
        arm, shots: cascade.getRouter().getRunScreenshots?.() ?? { sent: 0, leftOut: 0 }, steps: stepCount, withheld: withheldCount,
      });
      rows.push({
        model, arm, task: task.id, ...assessment,
        steps: stepCount,
        seconds: Math.round((Date.now() - started) / 1000),
        shots,
      });
      console.log(`${assessment.valid ? assessment.ok ? 'PASS' : 'FAIL' : 'EXCLUDED'}  ${model}  ${arm.padEnd(6)}  ${task.id.padEnd(11)}  ${assessment.costUsd === null ? 'cost unavailable' : `$${assessment.costUsd.toFixed(4)}`}${assessment.error ? `  ${assessment.error}` : ''}`);
    } finally {
      // Each run owns its telemetry and connections. Clean up even when
      // isolation fails, before deleting the workspace.
      await cascade.close().catch(() => {});
      for (const id of [...steps.keys()].filter((k) => !known.has(k))) {
        await controller.endRun(id).catch(() => {});
      }
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }
  await controller.dispose().catch(() => {});

  const out = args.out ?? 'browser-vision-eval-results.md';
  fs.writeFileSync(out, summarise(rows, tasks));
  // Beside the summary, never over it: `--out results` has no .md to replace.
  const json = /\.md$/i.test(out) ? out.replace(/\.md$/i, '.json') : `${out}.json`;
  fs.writeFileSync(json, JSON.stringify(rows, null, 2));
  console.log(`\nWrote ${out}`);
}

/** Wait up to two seconds for the page's report that `key` was done. */
async function reported(key) {
  for (let waited = 0; waited < 2_000 && !site.done.has(key); waited += 100) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ── The site, and a browser to drive it ──────

async function serveSite() {
  const done = new Set();
  const root = path.join(here, 'site');
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      res.statusCode = 400;
      res.end();
      return;
    }
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
  // Chrome's sandbox does not start as root, which a container often is;
  // everywhere else it stays on.
  const sandbox = process.getuid?.() === 0 ? ['--no-sandbox'] : [];
  const child = spawn(binary, [
    '--headless=new', ...sandbox, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`, '--window-size=1280,800', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  // A browser that never says where it listens is not left behind, nor is
  // its profile: the caller gets no handle to clean up after a failed start.
  let started = false;
  const abandon = () => {
    if (started) return;
    child.kill('SIGKILL');
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* the exit may still be writing it */ }
  };
  const ws = await new Promise((resolve, reject) => {
    let err = '';
    const timer = setTimeout(() => { abandon(); reject(new Error(`Chromium did not start: ${err.slice(-400)}`)); }, 15_000);
    const onStartupStderr = (d) => {
      // Only startup diagnostics matter. Do not accumulate or repeatedly scan
      // potentially unbounded browser logs during the benchmark itself.
      err = (err + String(d)).slice(-4096);
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) {
        child.stderr.off('data', onStartupStderr);
        child.stderr.resume(); // keep draining the pipe, but discard later logs
        clearTimeout(timer);
        started = true;
        resolve(m[1]);
      }
    };
    child.stderr.on('data', onStartupStderr);
    child.on('exit', (code) => { clearTimeout(timer); abandon(); reject(new Error(`Chromium exited (${code}): ${err.slice(-400)}`)); });
    // No such binary: say so, with the way to name another.
    child.on('error', (e) => { clearTimeout(timer); abandon(); reject(new Error(`Chromium could not start (${e.message}). Name one with --chromium <path>.`)); });
  });
  const kill = async () => {
    // Chromium keeps writing its profile until it has gone; removing it sooner
    // races that.
    const exited = child.exitCode !== null || child.signalCode !== null;
    const gone = exited ? Promise.resolve(true) : new Promise((r) => child.once('exit', () => r(true)));
    const waited = (ms) => new Promise((r) => setTimeout(r, ms, false).unref());
    child.kill();
    // One that is wedged, or ignores the request, is not left running — nor
    // its pipe, which would keep this process from ending.
    if (!(await Promise.race([gone, waited(5_000)]))) {
      child.kill('SIGKILL');
      await Promise.race([gone, waited(5_000)]);
    }
    child.stderr.destroy();
    // Its helper processes can outlive it for a moment. A temporary profile
    // left behind is not worth failing a finished run over.
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (e) {
      console.warn(`Could not remove the temporary profile ${profile}: ${e.message}`);
    }
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
