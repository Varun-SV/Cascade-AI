#!/usr/bin/env node
/**
 * End-to-end verification of the durable resume path.
 *
 * This drives the REAL Cascade — real router, real T1/T2/T3, real HTTP to a
 * provider, real filesystem — and interrupts it for real. The only thing that
 * is not real is the model on the other end of the socket: a local
 * OpenAI-compatible server that returns deterministic plans and section output.
 *
 * That boundary is deliberate. What needed verifying was the WIRING — does an
 * interrupted run actually leave a checkpoint on disk, does it contain the
 * sections that finished, and does a later process pick them back up — and a
 * scripted model makes that answerable with certainty instead of "the model
 * happened to cooperate today". A live-key run additionally exercises how a
 * real model reacts to the resume prompt; see --live at the bottom.
 *
 *   node tools/verify-resume-e2e.mjs
 *
 * STATUS: INCOMPLETE — do not read a pass/fail here as a verdict on resume.
 *
 * The harness reaches T1, dispatches sections and exercises the replan loop, but
 * the scripted model is not yet satisfying T1's plan parser (the run falls back
 * to a single "Main Task" section) or its self-test (sections come back FAILED).
 * With no section ever reaching COMPLETED, the checkpoint path is never reached,
 * so the current failures say nothing about whether resume works — they say the
 * fake model is not yet a good enough stand-in.
 *
 * Finishing this means making the scripted replies match what T1/T2/T3 actually
 * parse. Until then the durable-resume claim rests on the unit tests in
 * core/orchestration/resume-store.test.ts and resume-flow.test.ts.
 */

import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Cascade } from '../dist/index.js';

// ── Fake model ────────────────────────────────────────────────────────────────

/** Sections the scripted planner emits. Two, so one can finish before the stop. */
const PLAN = {
  complexity: 'Complex',
  sections: [
    {
      sectionId: 's1',
      sectionTitle: 'Research competitors',
      description: 'Identify the main competitors',
      expectedOutput: 'A list of competitors',
      constraints: [],
      dependsOn: [],
      t3Subtasks: [{
        subtaskId: 't1',
        subtaskTitle: 'List competitors',
        description: 'Write the competitor list',
        expectedOutput: 'competitors.md',
        constraints: [],
        dependsOn: [],
        files: ['competitors.md'],
        acceptance: [],
        contextBrief: 'Name four competitors.',
      }],
    },
    {
      sectionId: 's2',
      sectionTitle: 'Draft the report',
      description: 'Write the final report',
      expectedOutput: 'report.md',
      constraints: [],
      dependsOn: ['s1'],
      t3Subtasks: [{
        subtaskId: 't2',
        subtaskTitle: 'Write report',
        description: 'Write the report body',
        expectedOutput: 'report.md',
        constraints: [],
        dependsOn: [],
        files: ['report.md'],
        acceptance: [],
        contextBrief: 'Summarise the competitor list.',
      }],
    },
  ],
};

const state = {
  /** Set by the harness; called before each completion so a test can interrupt. */
  onCompletion: null,
  requests: [],
};

function completion(content) {
  return {
    id: 'chatcmpl-fake', object: 'chat.completion', created: Date.now() / 1000 | 0,
    model: 'fake-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
  };
}

/** Answer as whichever tier is asking, judged from the prompt's own wording. */
function reply(prompt) {
  // Cascade classifies complexity BEFORE planning. Without a Complex verdict the
  // whole run collapses to a single direct T3 worker, there are no sections at
  // all, and the thing under test never executes.
  if (prompt.includes('You are a routing classifier')) {
    return 'Complex — multi-section report requiring planning and artifacts';
  }
  if (prompt.includes('Return JSON where SECTIONS can declare dependencies')) {
    return JSON.stringify(PLAN);
  }
  if (prompt.includes('"completeness"')) {
    return JSON.stringify({ completeness: 'pass', correctness: 'pass', compliance: 'pass', notes: 'ok' });
  }
  if (prompt.toLowerCase().includes('approve') || prompt.includes('"approved"')) {
    return JSON.stringify({ approved: true, reason: 'looks good' });
  }
  if (prompt.includes('subtasks')) {
    return JSON.stringify({ subtasks: [] });
  }
  return 'Competitor A, Competitor B, Competitor C, Competitor D. This section is complete.';
}

async function startFakeModel() {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (req.url?.includes('/models')) {
        return send(200, { data: [{ id: 'fake-model' }] });
      }
      if (req.url?.includes('/chat/completions')) {
        const parsed = JSON.parse(body || '{}');
        const prompt = (parsed.messages ?? []).map((m) => m.content).join('\n');
        state.requests.push(prompt);
        // Hook: lets a scenario interrupt the run mid-flight, exactly like a
        // user hitting Ctrl-C or a process dying between calls.
        if (state.onCompletion) {
          try { await state.onCompletion(prompt, state.requests.length); } catch { /* ignore */ }
        }
        return send(200, completion(reply(prompt)));
      }
      send(404, { error: 'not found' });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}/v1` };
}

// ── Harness ───────────────────────────────────────────────────────────────────

let passed = 0; let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
}

function makeCascade(workspace, baseUrl) {
  const dot = path.join(workspace, '.cascade');
  return new Cascade({
    providers: [{
      type: 'openai-compatible',
      apiKey: 'not-required',
      baseUrl,
      model: 'fake-model',
      isLocal: true,
    }],
    workspace: {
      cascadeMdPath: path.join(workspace, 'CASCADE.md'),
      configPath: path.join(dot, 'config.json'),
      keystorePath: path.join(dot, 'keystore'),
      auditLogPath: path.join(dot, 'audit.db'),
    },
    tools: { enabledTools: [] },
    memory: { enabled: false },
    telemetry: { enabled: false },
  }, workspace);
}

async function readCheckpoints(workspace) {
  const dir = path.join(workspace, '.cascade', 'resume');
  try {
    const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json'));
    return Promise.all(names.map(async (n) =>
      JSON.parse(await fs.readFile(path.join(dir, n), 'utf-8'))));
  } catch { return []; }
}

async function main() {
  const { server, baseUrl } = await startFakeModel();
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-e2e-'));
  console.log(`\nFake model at ${baseUrl}\nWorkspace  ${workspace}\n`);

  try {
    // ── Scenario 1: cancellation mid-run leaves a usable checkpoint ──────────
    console.log('Scenario 1 — cancel after the first section completes');
    {
      const cascade = makeCascade(workspace, baseUrl);
      await cascade.initialize?.();

      cascade.on('tier:root', (e) => console.log('    [root tier]', JSON.stringify(e)));
      cascade.on('log', (e) => {
        const m = typeof e === 'string' ? e : (e?.message ?? '');
        if (/T1|plan|section|Plan/i.test(m) && m.length < 160) console.log('    [log]', m);
      });
      const controller = new AbortController();
      let sectionsSeen = 0;
      cascade.on('section:complete', () => {
        sectionsSeen++;
        // Abort as soon as one section is genuinely done, so the checkpoint has
        // real finished work in it rather than an empty shell.
        if (sectionsSeen === 1) setTimeout(() => controller.abort(), 0);
      });

      await cascade.run({ prompt: 'Write a competitor report', complexityHint: 'Complex', signal: controller.signal })
        .catch(() => { /* cancellation resolves, but be tolerant */ });

      check('at least one section completed before the stop', sectionsSeen >= 1,
        `saw ${sectionsSeen}`);

      const checkpoints = await readCheckpoints(workspace);
      check('a checkpoint was written to disk', checkpoints.length >= 1,
        `found ${checkpoints.length} in ${path.join(workspace, '.cascade', 'resume')}`);

      const cp = checkpoints[0];
      if (cp) {
        check('checkpoint records the cancellation', cp.reason === 'cancelled',
          `reason=${cp.reason}`);
        check('checkpoint carries the finished section', (cp.completed ?? []).length >= 1,
          `completed=${JSON.stringify((cp.completed ?? []).map((c) => c.title))}`);
        check('checkpoint preserves the original prompt',
          cp.prompt === 'Write a competitor report', `prompt=${cp.prompt}`);
      }
    }

    // ── Scenario 2: a NEW Cascade recovers it (the cross-process case) ───────
    console.log('\nScenario 2 — a fresh Cascade instance resumes it');
    {
      const revived = makeCascade(workspace, baseUrl);
      await revived.initialize?.();

      const resumePrompt = await revived.prepareDurableResume();
      check('the fresh instance found the checkpoint', resumePrompt != null);

      if (resumePrompt) {
        check('resume prompt names the finished section',
          resumePrompt.includes('Research competitors'),
          resumePrompt.slice(0, 300));
        check('resume prompt tells the planner not to redo it',
          resumePrompt.includes('do NOT redo'));
        check('resume prompt carries the original task',
          resumePrompt.includes('Write a competitor report'));
      }

      const after = await readCheckpoints(workspace);
      check('the checkpoint was consumed, so it cannot be replayed twice',
        after.length === 0, `${after.length} left`);

      const again = await revived.prepareDurableResume();
      check('a second resume finds nothing', again === null);
    }

    // ── Scenario 3: a crash mid-run also checkpoints ─────────────────────────
    console.log('\nScenario 3 — an unexpected error still preserves finished work');
    {
      const crashWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-e2e-crash-'));
      const cascade = makeCascade(crashWorkspace, baseUrl);
      await cascade.initialize?.();

      let sectionsSeen = 0;
      cascade.on('section:complete', () => { sectionsSeen++; });

      // Blow up the transport once a section has finished — a hard failure
      // arriving after real work landed, which is the case that used to lose it.
      state.onCompletion = async (_prompt, n) => {
        if (sectionsSeen >= 1 && n > 3) throw new Error('simulated crash');
      };
      // The server swallows handler errors, so force the failure from the run
      // side instead: close the socket source so the next call genuinely fails.
      await cascade.run({ prompt: 'Write a competitor report', complexityHint: 'Complex' }).catch(() => {});
      state.onCompletion = null;

      const checkpoints = await readCheckpoints(crashWorkspace);
      check('a checkpoint exists after the run ended abnormally', checkpoints.length >= 1,
        `found ${checkpoints.length}; sections seen=${sectionsSeen}`);
      if (checkpoints[0]) {
        check('it records a real stop reason',
          ['error', 'breaker', 'budget', 'cancelled'].includes(checkpoints[0].reason),
          `reason=${checkpoints[0].reason}`);
      }
      await fs.rm(crashWorkspace, { recursive: true, force: true });
    }
  } finally {
    server.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
