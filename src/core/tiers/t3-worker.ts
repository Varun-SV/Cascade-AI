// ─────────────────────────────────────────────
//  Cascade AI — T3 Worker
// ─────────────────────────────────────────────

import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ConversationMessage,
  GenerateOptions,
  ModelInfo,
  PermissionRequest,
  T2ToT3Assignment,
  T3Result,
  ToolCall,
  ToolDefinition,
} from '../../types.js';
import type { CascadeRouter } from '../router/index.js';
import type { ToolRegistry } from '../../tools/registry.js';
import { BaseTier } from './base.js';
import { ContextManager } from '../context/manager.js';
import { AuditLogger } from '../../audit/log.js';
import { MemoryStore } from '../../memory/store.js';
import type { PeerBus } from '../peer/bus.js';
import type { PermissionEscalator } from '../permissions/escalator.js';
import type { ToolCreator, GeneratedToolSpec } from '../../tools/tool-creator.js';
import type { WorldStateDB } from '../knowledge/world-state.js';
import {
  parseTextToolCalls,
  toToolCall,
  buildTextToolSystemPrompt,
  buildTextToolReminder,
} from '../../tools/text-tool-parser.js';
import { truncateForContext } from '../../utils/truncate.js';
import { classifyProviderError } from '../router/provider-errors.js';
import {
  evaluateAcceptance, failures, undecided, type AcceptanceResult,
} from '../verification/acceptance.js';

/**
 * Thrown by executeTool() when the underlying tool error indicates a condition
 * this worker must not keep paying to rediscover — a systemic provider failure
 * (rate limit, auth, quota, dead model), or ANY failure of a provider-backed
 * media generation tool, whose every attempt is separately billed. The agent
 * loop stops immediately and the worker escalates with the real reason intact.
 */
export class CriticalToolError extends Error {
  constructor(message: string, public readonly toolName: string) {
    super(message);
    this.name = 'CriticalToolError';
  }
}

/**
 * Thrown by runAgentLoop() when the worker is stuck producing an artifact
 * that verifyArtifacts() rejects on consecutive iterations. Carries any
 * partial output the worker had built so the caller can surface it
 * instead of just the bare error string.
 */
export class WorkerStallError extends Error {
  constructor(message: string, public readonly partialOutput: string) {
    super(message);
    this.name = 'WorkerStallError';
  }
}

// The worker's system prompt is assembled per-run from the tools that are
// ACTUALLY registered, not a fixed list. When Cascade is embedded with a
// restricted tool set (e.g. the hosted `cloud/server`, which enables only
// web_search/web_fetch), instructing the model to "use run_code" or "create a
// file in the workspace" just makes it call tools that don't exist and burn
// turns on tool-not-found errors. With the full desktop tool set every line
// below renders, so the prompt is byte-identical to the previous static one.
// Every tool the built-in registry can register (registry.ts registerDefaults).
// Used only to decide whether ANY tool is present — a fully restricted run
// (e.g. hosted pure-chat with enabledTools: []) then drops the generic
// "use tools" guidance entirely, so the model is never told to reach for a
// capability it doesn't have.
const KNOWN_TOOLS = [
  'shell', 'file_read', 'file_write', 'file_edit', 'file_delete', 'file_list',
  'git', 'github', 'image_analyze', 'pdf_create', 'run_code', 'peer_message',
  'web_search', 'glob', 'grep', 'web_fetch',
  // Every media tool buildMediaTools can register, not just the image one.
  // Omitting three of the four meant a run whose ONLY tools were media ones
  // (a video-generation subtask on an account with no file/web tools) counted
  // as "no tools registered" and dropped all tool guidance — the worker was
  // then told nothing about using tools at all, and wrote the video as prose.
  'generate_image', 'generate_video', 'generate_speech', 'transcribe_audio',
  'generate_document',
];

/**
 * Tools whose implementation genuinely calls an LLM/media provider's HTTP
 * API (via multimodal/generate.ts's postJson, which attaches the real
 * status code) — the only tools whose thrown errors classifyProviderError
 * should ever be run against. See its call site in executeTool().
 */
const PROVIDER_BACKED_TOOLS = new Set([
  'generate_image', 'generate_speech', 'generate_video', 'transcribe_audio',
]);

export function buildWorkerRules(has: (toolName: string) => boolean): string {
  const canWriteFiles = has('file_write') || has('file_edit') || has('run_code');
  const hasAnyTool = KNOWN_TOOLS.some(has);
  const rules: Array<string | false> = [
    '- Execute the subtask completely — do not stop partway through.',
    hasAnyTool && '- Use tools when needed. Ask for approval only when the tool registry requires it.',
    canWriteFiles &&
      '- If the task asks for a file or artifact, you must actually create it in the workspace, verify that it exists, and inspect it before claiming success.',
    has('web_search') &&
      '- Use the "web_search" tool to find current information, documentation, news, or general web data.',
    has('pdf_create') && '- Use the "pdf_create" tool for PDF requests.',
    // A .docx/.pptx/.xlsx is a ZIP of OOXML parts, not text with a suffix.
    // file_write does exactly what it promises — writes the model's characters
    // verbatim — so without this rule the worker "wrote" a Word document that
    // Word correctly reported as corrupted. Stated as an explicit prohibition
    // on the tool it would otherwise reach for, because "use generate_document"
    // alone competes with a file_write habit the model already has.
    has('generate_document') &&
      '- For a Word (.docx), PowerPoint (.pptx) or Excel (.xlsx) deliverable you MUST call the "generate_document" tool and NEVER "file_write" or "run_code" — those formats are ZIP archives of XML, so text written straight to the path opens as a corrupted file. Pass the target path plus the source: Markdown for .docx, Markdown slides separated by --- rules for .pptx (each slide starts with a heading), CSV for .xlsx.',
    // The alternative to this rule is not "a worse chart" — it is a paragraph
    // describing a chart that does not exist, which is what real decks came
    // back with. A `chart:` block is checkable, carries the exact numbers, and
    // becomes a genuine editable PowerPoint chart object.
    has('generate_document') &&
      '- For any data-driven visualization (a chart, graph, trend, breakdown or comparison of numbers), emit a fenced ```chart:bar block — also chart:line, chart:pie, chart:doughnut, chart:area, chart:scatter — whose body is an optional "title: ..." line followed by CSV: a header row of "<category label>,<series name>,<series name>", then one row per category. In a PowerPoint deliverable that becomes a REAL, editable chart carrying your exact numbers; in Word and Excel the same block keeps every value as a table or worksheet. Never write prose describing a chart in place of emitting one.',
    // Without this the model "writes the image" as prose — a bracketed
    // description sitting in the deck where the picture should be — even with a
    // working image model registered. Naming the reference syntax matters as
    // much as naming the tool: a generated image nobody embeds is still a
    // missing image. It also has to say the reference must stand ALONE on its
    // line, because only a standalone reference is parsed as a picture (see
    // core/documents/blocks.ts matchImageLine) — one embedded mid-sentence
    // silently degrades to caption text.
    //
    // Scoped to PowerPoint/Word specifically: those are the only renderers that
    // actually embed a Markdown image reference. PDF and plain-text/Markdown
    // deliverables flatten a reference straight to caption text — telling the
    // model to call generate_image for THOSE just pays for an image nobody
    // ever sees.
    has('generate_image') &&
      // Supersedes the earlier wording of this same rule: it now names the
      // standalone-line parser constraint, says to generate BEFORE writing the
      // document, and points data-driven visuals at a ```chart: block rather
      // than a Markdown table, which is only the right advice now that chart
      // blocks render as real chart objects.
      '- When a slide deck (PowerPoint) or Word document deliverable calls for a decorative image, photo or illustration, you MUST call the "generate_image" tool — once per image the deliverable needs, BEFORE you write the document — and then put each result on a line of its OWN using Markdown image syntax: ![description](location), where "location" is exactly the string the tool reported back. A reference inside a sentence stays prose and no picture appears. NEVER write a text placeholder or a bracketed description such as [image: a cat] in its place, and never state that an image is included when you did not generate one. Do NOT use "generate_image" for a chart, graph or diagram that must show exact data (numbers, axes, labels) — an image model cannot guarantee those values are correct; emit a ```chart: block instead. For any OTHER deliverable format (PDF, plain text, code, etc.) do NOT call "generate_image" — those cannot embed the result, so describe the visual in words instead.',
    // The other half of image reliability, and the half no amount of
    // instruction-tightening could fix: generate_image only exists when an
    // OpenAI or Gemini key is configured (multimodal/registry.ts CAPABILITIES).
    // With neither, the model was never given a choice — and a model that
    // doesn't know that writes "[illustration of a cat]" and moves on. Said out
    // loud, up front, so the fallback is a real chart or honest prose.
    !has('generate_image') && (has('generate_document') || canWriteFiles) &&
      '- No image-generation model is available on this run, so there is NO tool that can draw a picture. Do not emit a Markdown image reference, a bracketed placeholder such as [image: a cat], or any claim that an illustration is included. If the request needs a data visualization use a ```chart: block, which needs no image model; otherwise describe the visual in words and say plainly that no image could be generated.',
    // The video counterpart of the image rule above, and the fix for the
    // reported "it writes scripts forever and never makes the video" run. The
    // failure mode is identical — the model narrates the deliverable instead of
    // producing it — but the stakes are not: a video subtask that ends in prose
    // has burned the whole pre-production plan for nothing. Unlike the image
    // rule this is NOT scoped to a document format, because the clip itself is
    // the deliverable rather than an illustration inside one, and the reference
    // syntax is a plain link: Markdown image syntax does not embed a video.
    has('generate_video') &&
      '- When the subtask deliverable is a video, you MUST call the "generate_video" tool — that call IS the deliverable, and the subtask is not done until it has returned. NEVER deliver the video as prose, a script, a storyboard, or a bracketed placeholder such as [video: a cat skating], and NEVER claim a video exists unless the tool reported a location for it. Call it exactly ONCE: it is billed per second of output and renders for minutes, so a second call charges the user again. Then report the location string the tool returned VERBATIM as your result, referencing it as [description](location) if it goes inside a document. If the tool reports a failure or a timeout, report that failure verbatim and stop — do NOT call it again, and do NOT substitute a written description of a video that was never made.',
    has('run_code') &&
      `- Use the "run_code" tool for data processing, archives, and file formats not covered by a dedicated tool. ${
        has('generate_document') ? 'Do NOT use it to build a .docx, .pptx or .xlsx — "generate_document" already produces those correctly. ' : ''
      }${has('pdf_create') ? 'Do NOT use it to build a PDF — "pdf_create" does that. ' : ''}Always cleanup after code execution.`,
    '- If you are not making meaningful progress, stop and escalate rather than looping or padding the response.',
    has('peer_message') &&
      '- Use the "peer_message" tool to communicate with other T3 workers if your tasks have dependencies or shared state. You can send updates or wait for signals.',
    hasAnyTool &&
      '- Only use tools directly relevant to THIS subtask. Do not reach for an unrelated connected-service action (e.g. creating, deleting, or modifying a repository, issue, or PR; sending a message) unless the subtask explicitly calls for it.',
    '- Return structured output that directly addresses the expected output specification.',
  ];
  return `You are a T3 Worker agent in the Cascade AI system. Your job is to execute a specific subtask completely and accurately.

Rules:
${rules.filter((r): r is string => r !== false).join('\n')}`;
}

/** File-writing tools — a worker can only produce a file artifact if it has one. */
const ARTIFACT_TOOLS = new Set(['file_write', 'file_edit', 'shell', 'generate_document']);

/**
 * Filenames worth treating as a promised artifact. Office extensions are here
 * because there is now a tool that can genuinely produce them — before
 * generate_document, a subtask naming `deck.pptx` could only ever have been
 * satisfied by writing text into a file Office refuses to open.
 */
const ARTIFACT_FILE_RE =
  /\b[\w./-]+\.(pdf|md|html|txt|json|csv|py|js|ts|tsx|jsx|docx?|pptx?|xlsx?|png|jpg|jpeg|svg|gif)\b/i;

/**
 * Whether a worker should be *required* to produce a verified file artifact.
 *
 * The task text may describe a file deliverable, but requiring one is only sane
 * when the worker actually has a tool that can create it. A hosted chat run, for
 * example, enables only web_search/web_fetch — with no file-writing tool the
 * worker can never satisfy the check, so it used to loop and then throw
 * WorkerStallError ("stalled waiting for artifact creation…"), surfacing as an
 * `(incomplete: …)` answer. With no such tool the worker's generated text IS the
 * deliverable, so we don't demand a file it has no way to write.
 */
export function shouldRequireArtifact(
  assignment: { files?: string[]; description?: string; expectedOutput?: string } | undefined,
  toolNames: string[],
): boolean {
  if (!toolNames.some((n) => ARTIFACT_TOOLS.has(n))) return false;
  // An explicit spec slice is authoritative — no regex guessing needed.
  if (assignment?.files?.length) return true;
  const haystack = `${assignment?.description ?? ''}\n${assignment?.expectedOutput ?? ''}`;
  return ARTIFACT_FILE_RE.test(haystack)
    || /save (?:a|the)? file|create (?:a|the)? file|write (?:a|the)? file/i.test(haystack);
}

/** Words that mean "this deliverable is supposed to SHOW something". */
const VISUAL_REQUEST_RE =
  /\b(image|images|picture|pictures|photo|photos|illustration|illustrations|visual|visuals|visualisation|visualization|visualizations|chart|charts|graph|graphs|plot|plots|diagram|diagrams|infographic)\b/i;

/** Evidence the output really CONTAINS a visual, not a sentence about one. */
const IMAGE_REF_RE = /!\[[^\]]*\]\([^)]+\)/;
const CHART_BLOCK_RE = /^\s*```+\s*chart\s*:/im;

/**
 * "You asked for a picture — is there one?"
 *
 * The `generate_image` rule was already an emphatic MUST and real decks still
 * came back with zero images and zero charts, just prose describing what a
 * chart would have shown. An instruction the model can silently decline is not
 * a guarantee; this is the checkable version of the same requirement, in the
 * spirit of verifyArtifacts ("did the file the subtask promised actually get
 * written?").
 *
 * Deliberately narrow, because a false positive costs a correction round on a
 * perfectly good answer:
 *   • only when the subtask ITSELF asks for a visual;
 *   • only when a tool that could satisfy it is registered — with neither
 *     generate_image nor generate_document there is nothing to demand;
 *   • satisfied by ANY of: an embedded image reference, a `chart:` block, or a
 *     generate_image / generate_document call (the binary path writes the
 *     picture into a file, so it will never appear in the worker's text).
 *
 * Returns the issue to correct, or null when the deliverable is fine.
 */
export function missingVisualEvidence(
  assignment: { description?: string; expectedOutput?: string } | undefined,
  output: string,
  calledTools: string[],
  toolNames: string[],
): string | null {
  const canVisualize = toolNames.includes('generate_image') || toolNames.includes('generate_document');
  if (!canVisualize) return null;
  const haystack = `${assignment?.description ?? ''}\n${assignment?.expectedOutput ?? ''}`;
  if (!VISUAL_REQUEST_RE.test(haystack)) return null;
  if (calledTools.includes('generate_image') || calledTools.includes('generate_document')) return null;
  if (IMAGE_REF_RE.test(output) || CHART_BLOCK_RE.test(output)) return null;

  const options: string[] = [];
  if (toolNames.includes('generate_image')) {
    options.push('call "generate_image" and reference the result on its own line as ![description](location)');
  }
  if (toolNames.includes('generate_document')) {
    options.push('emit a fenced ```chart:bar (or chart:line / chart:pie) block whose body is CSV, for anything data-driven');
  }
  return `The subtask asks for a visual, but the output contains no embedded image and no chart block — only prose. ${
    options.join(', or ')
  }. Describing a picture is not producing one.`;
}

export class T3Worker extends BaseTier {
  private router: CascadeRouter;
  private toolRegistry: ToolRegistry;
  private context: ContextManager;
  private assignment?: T2ToT3Assignment;
  /** True when this subtask matched a privacy.paths local-only pattern. */
  private localOnlyMatch = false;
  private peerSyncBuffer: Array<{ fromId: string; content: unknown; timestamp: string }> = [];
  private store?: MemoryStore;
  private audit?: AuditLogger;
  private tools: ToolDefinition[] = [];
  /** 0 = top-level worker (may request reinforcements); 1 = a spawned reinforcement (may not). */
  private reinforcementDepth = 0;
  /** Sibling-worker requests this worker made via request_workers (T3→T2). */
  private pendingReinforcements: T2ToT3Assignment[] = [];
  /** @deprecated — kept only as fallback when no escalator is attached */
  private sessionApprovals: Map<string, boolean> = new Map();
  private peerBus?: PeerBus;
  private permissionEscalator?: PermissionEscalator;
  private toolCreator?: ToolCreator;

  setPeerBus(bus: PeerBus): void {
    this.peerBus = bus;
    this.peerBus.register(this.id);

    // Listen for targeted messages from peers
    this.peerBus.on(`message:${this.id}`, (msg) => {
      this.log(`Peer message from ${msg.fromId}: ${msg.type}`);
      this.receivePeerSync(msg.fromId, msg.payload);
    });

    // A peer created a runtime tool — register it locally and refresh our tool
    // list so we can use it without regenerating the same capability.
    this.peerBus.on('broadcast', (msg) => {
      const payload = msg?.payload as { type?: string; spec?: GeneratedToolSpec } | undefined;
      if (payload?.type === 'TOOL_CREATED' && payload.spec && this.toolCreator) {
        this.toolCreator.registerSpec(payload.spec);
        this.tools = this.toolRegistry.getToolDefinitions();
        this.log(`Registered peer tool "${payload.spec.name}" from broadcast.`);
      }
    });
  }

  setPermissionEscalator(escalator: PermissionEscalator): void {
    this.permissionEscalator = escalator;
  }

  /** Marks this worker as a spawned reinforcement (depth 1 — cannot request more). */
  markAsReinforcement(): void {
    this.reinforcementDepth = 1;
  }

  setToolCreator(creator: ToolCreator): void {
    this.toolCreator = creator;
  }

  constructor(router: CascadeRouter, toolRegistry: ToolRegistry, parentId: string) {
    super('T3', undefined, parentId);
    this.router = router;
    this.toolRegistry = toolRegistry;
    this.context = new ContextManager();
  }

  setStore(store: MemoryStore, sessionId: string): void {
    this.store = store;
    this.audit = new AuditLogger(store, sessionId);
  }

  async execute(assignment: T2ToT3Assignment, taskId: string, signal?: AbortSignal): Promise<T3Result> {
    this.signal = signal;
    this.assignment = assignment;
    this.taskId = taskId;
    this.setLabel(assignment.subtaskTitle);
    this.setStatus('ACTIVE');

    // ── Per-path privacy tier ──────────────────
    // A subtask touching a local-only path runs on private models only and
    // its raw output is withheld from the tiers above (see privacy/paths.ts).
    const privacy = this.router.getPrivacyPaths?.();
    this.localOnlyMatch = !!privacy?.hasPolicies() && privacy.anyLocalOnly(this.extractArtifactPaths(assignment));
    if (this.localOnlyMatch) {
      this.log('Privacy: subtask touches a local-only path — forcing a private model; raw output will be withheld upstream.');
    }

    this.tools = this.toolRegistry.getToolDefinitions();
    // T3→T2 reinforcement: surface request_workers to top-level workers only, when enabled.
    if (this.reinforcementDepth === 0 && this.router.getReinforcementsConfig?.()?.enabled) {
      this.tools = [...this.tools, {
        name: 'request_workers',
        description: 'Ask your manager to spawn additional sibling workers for sub-problems you discover are too large or parallelizable to finish alone. Use sparingly — only when the work genuinely needs to fan out.',
        inputSchema: {
          type: 'object',
          properties: {
            subtasks: {
              type: 'array',
              description: 'New sibling subtasks for your manager to spawn.',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  description: { type: 'string' },
                  expectedOutput: { type: 'string' },
                },
                required: ['title', 'description'],
              },
            },
          },
          required: ['subtasks'],
        },
      }];
    }

    // ── Step 0: Wait for dependencies ──────────
    if (assignment.dependsOn?.length && this.peerBus) {
      this.sendStatusUpdate({
        progressPct: 0,
        currentAction: `Waiting for dependencies: ${assignment.dependsOn.join(', ')}`,
        status: 'IN_PROGRESS',
      });

      const depOutputs: string[] = [];
      for (const depId of assignment.dependsOn) {
        try {
          // Bounded wait: the wave scheduler only starts us after our deps have
          // completed, so this normally resolves immediately. The 60s cap is a
          // safety net for genuinely-missing/cross-bus deps.
          const dep = await this.peerBus.waitFor(depId, 60_000);
          if (dep.status === 'FAILED' || dep.status === 'ESCALATED') {
            // Publish a terminal status for OUR subtask before bailing, so our
            // own dependents unblock at once instead of each waiting out the full
            // peer timeout — that per-link stacking was the apparent "deadlock".
            this.peerBus.publish(this.id, assignment.subtaskId, `Blocked by failed dependency: ${depId}`, 'FAILED');
            return this.buildResult(
              'ESCALATED',
              `Dependency ${depId} failed — cannot proceed`,
              { checksRun: [], passed: [], failed: [] },
              [`Blocked by failed dependency: ${depId}`],
              0,
            );
          }
          depOutputs.push(`[From ${dep.fromId} - ${dep.subtaskId}]:\n${dep.output}`);
        } catch (err) {
          this.peerBus.publish(this.id, assignment.subtaskId, `Dependency timeout: ${depId}`, 'FAILED');
          return this.buildResult(
            'ESCALATED',
            `Dependency timeout: ${depId}`,
            { checksRun: [], passed: [], failed: [] },
            [err instanceof Error ? err.message : String(err)],
            0,
          );
        }
      }

      // Inject dependency outputs into context
      if (depOutputs.length) {
        await this.context.addMessage({
          role: 'user',
          content: `Context from completed dependencies:\n\n${depOutputs.join('\n\n')}\n\nNow execute your subtask using this context where relevant.`,
        });
      }
    }

    this.sendStatusUpdate({
      progressPct: 5,
      currentAction: `Starting subtask: ${assignment.subtaskTitle}`,
      status: 'IN_PROGRESS',
    });

    this.log(`T3 executing subtask: ${assignment.subtaskTitle}`);

    // ── Step 0.5: T3 File-Intent Coordination ──
    // Announce files this subtask plans to write so siblings can avoid conflicts.
    if (this.peerBus && this.peerBus.getMembers().length > 1) {
      await this.coordinateFileIntents(assignment);
    }

    const systemPrompt = this.buildSystemPrompt(assignment);

    await this.context.addMessage({
      role: 'user',
      content: this.buildInitialPrompt(assignment),
    });

    let output = '';
    let toolCalls: ToolCall[] = [];
    // Counts every correction round this subtask actually took. It used to be
    // ASSIGNED 1 at each of the (now four) correction sites rather than
    // incremented, so a worker that corrected for a missing artifact, then for
    // acceptance, then for a failed self-test reported the same "1" as one that
    // corrected once. The field is the only per-attempt signal downstream has —
    // reported as correctionAttempts in T3Result and used to judge whether a
    // tier is struggling — so a boolean wearing a number's clothes made a
    // three-round subtask indistinguishable from a clean one.
    let correctionAttempts = 0;
    const checksRun: string[] = [];
    const passed: string[] = [];
    const failed: string[] = [];
    const issues: string[] = [];

    try {
      const result = await this.runAgentLoop(systemPrompt, this.tools);
      output = result.output;
      toolCalls = result.toolCalls;

      // Only demand a file when this worker could actually have written one.
      // `requiresArtifact()` already gates the PROMPT side (see the artifact
      // instructions below) — but this verification ran unconditionally, so a
      // worker with no file tools was told not to write files and then failed
      // for not having written them. The check regex-matches filenames out of
      // the subtask description, so a research plan that merely mentions
      // "report.md" produced an unsatisfiable requirement: correctOutput ran, the
      // re-check failed again, and the subtask ESCALATED with the model's
      // perfectly good prose attached. That is the "successful node marked
      // failed" case.
      const mustProduceArtifact = this.requiresArtifact();
      if (mustProduceArtifact) {
        this.sendStatusUpdate({ progressPct: 65, currentAction: 'Verifying required artifacts', status: 'IN_PROGRESS' });
      }

      const artifactCheck = mustProduceArtifact
        ? await this.verifyArtifacts(assignment)
        : { ok: true, issues: [] };
      if (!artifactCheck.ok) {
        correctionAttempts++;
        issues.push(...artifactCheck.issues);
        output = await this.correctOutput(output, artifactCheck.issues);
        const retryArtifactCheck = await this.verifyArtifacts(assignment);
        if (!retryArtifactCheck.ok) {
          issues.push(...retryArtifactCheck.issues);
          this.setStatus('FAILED');
          // ── Publish failure to peers ──
          this.peerBus?.publish(this.id, assignment.subtaskId, output, 'ESCALATED');
          return this.buildResult('ESCALATED', output, { checksRun, passed, failed }, issues, correctionAttempts);
        }
      }

      // "You asked for a picture — is there one?" The MUST-call-generate_image
      // rule is an instruction the model can silently decline, and real decks
      // proved it does: no image, no chart, just a paragraph describing one.
      // One correction round, with tools, so the worker can still go and make
      // the thing. Not a hard failure — a missing illustration should never
      // throw away an otherwise-good deliverable.
      const visualIssue = missingVisualEvidence(
        assignment, output, toolCalls.map((t) => t.name), this.tools.map((t) => t.name),
      );
      if (visualIssue) {
        correctionAttempts++;
        issues.push(visualIssue);
        this.sendStatusUpdate({ progressPct: 68, currentAction: 'Verifying requested visuals', status: 'IN_PROGRESS' });
        output = await this.correctOutput(output, [visualIssue]);
      }

      // ── Deterministic rung of the verification ladder ──
      //
      // Acceptance criteria are specified (t1-administrator.ts) as "checks a
      // reviewer could verify mechanically (file exists / contains X)", but
      // until now every one of them was graded only by selfTest() — an LLM,
      // which is a worse judge of "does this file exist" than stat is, and which
      // will happily pass a criterion because the output *claims* the file was
      // written. Decide what can be decided by looking; anything ambiguous is
      // left untouched for the model, so this only ever adds certainty.
      const acceptanceResults = await this.checkAcceptance(assignment);
      const acceptanceFailures = failures(acceptanceResults);
      if (acceptanceFailures.length > 0) {
        correctionAttempts++;
        issues.push(...acceptanceFailures);
        this.sendStatusUpdate({ progressPct: 69, currentAction: 'Acceptance checks failed — correcting', status: 'IN_PROGRESS' });
        output = await this.correctOutput(output, acceptanceFailures);

        const recheck = failures(await this.checkAcceptance(assignment));
        if (recheck.length > 0) {
          // Deterministic and still failing: the file genuinely is not there.
          // No amount of LLM grading changes that, so stop rather than spend a
          // grading call to be told what stat already proved.
          issues.push(...recheck);
          checksRun.push(...acceptanceResults.map((r) => r.criterion));
          failed.push(...recheck);
          this.setStatus('FAILED');
          this.peerBus?.publish(this.id, assignment.subtaskId, output, 'ESCALATED');
          return this.buildResult('ESCALATED', output, { checksRun, passed, failed }, issues, correctionAttempts);
        }
      }
      for (const result of acceptanceResults) {
        if (result.verdict === 'undecidable') continue;
        checksRun.push(result.criterion);
        if (result.verdict === 'passed') passed.push(result.criterion);
      }

      this.sendStatusUpdate({ progressPct: 70, currentAction: 'Self-testing output', status: 'IN_PROGRESS' });

      const testResult = await this.selfTest(assignment, output, undecided(acceptanceResults));
      checksRun.push(...testResult.checksRun);
      passed.push(...testResult.passed);
      failed.push(...testResult.failed);

      if (testResult.failed.length > 0) {
        correctionAttempts++;
        issues.push(`Initial check failed: ${testResult.failed.join(', ')}`);
        const corrected = await this.correctOutput(output, testResult.failed);
        output = corrected;
        const retest = await this.selfTest(assignment, output);
        passed.push(...retest.passed);
        if (retest.failed.length > 0) {
          failed.push(...retest.failed);
          this.setStatus('FAILED');
          this.peerBus?.publish(this.id, assignment.subtaskId, output, 'ESCALATED');
          return this.buildResult('ESCALATED', output, { checksRun, passed, failed }, issues, correctionAttempts);
        }
      }

      // ── Reflection / self-critique (goal-alignment, opt-in) ──
      const reflectCfg = this.router.getReflectionConfig?.() ?? { enabled: false, maxRounds: 1 };
      if (reflectCfg.enabled) {
        this.sendStatusUpdate({ progressPct: 85, currentAction: 'Reflecting on output via T2-Critic', status: 'IN_PROGRESS' });
        output = await this.reflectAndImprove(assignment, output, reflectCfg.maxRounds);
      }

      // ── Project World State Update ──
      // Optional call: routers without a WorldStateDB (tests, SDK embedders)
      // skip the write instead of crashing the whole subtask.
      const db = this.router.getWorldStateDB?.();
      if (db) {
        try {
          db.addEntry(this.id, `Completed: ${assignment.subtaskTitle}. Output length: ${output.length} chars.`);
        } catch (e) {
          this.log('Failed to write to World State DB');
        }
        // world-state v2: distill the output into queryable facts (best-effort,
        // never blocks or fails the subtask). Skipped when disabled in config.
        if (this.router.getKnowledgeConfig?.().factsExtraction !== false) {
          await this.extractAndStoreFacts(db, assignment, output);
        }
      }

      this.setStatus('COMPLETED', output);
      this.sendStatusUpdate({ progressPct: 100, currentAction: 'Subtask complete', status: 'IN_PROGRESS', output });

      // ── Publish success to peers ─────────────
      this.peerBus?.publish(this.id, assignment.subtaskId, output, 'COMPLETED');

      return this.buildResult('COMPLETED', output, { checksRun, passed, failed }, issues, correctionAttempts);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Preserve partial output when the worker stalled mid-generation, and
      // mark critical/unrecoverable errors so T2/T1 can surface them clearly
      // instead of being swallowed under a generic "Execution error" prefix.
      if (err instanceof WorkerStallError) {
        issues.push(`Stalled: ${errMsg}`);
        const finalOutput = err.partialOutput || output || errMsg;
        this.setStatus('FAILED', finalOutput);
        this.peerBus?.publish(this.id, assignment.subtaskId, finalOutput, 'FAILED');
        return this.buildResult('ESCALATED', finalOutput, { checksRun, passed, failed }, issues, correctionAttempts);
      }
      if (err instanceof CriticalToolError) {
        issues.push(`[CRITICAL_TOOL_ERROR] ${err.toolName}: ${errMsg}`);
        const finalOutput = output || `Tool "${err.toolName}" failed unrecoverably: ${errMsg}`;
        this.setStatus('FAILED', finalOutput);
        this.peerBus?.publish(this.id, assignment.subtaskId, finalOutput, 'FAILED');
        return this.buildResult('ESCALATED', finalOutput, { checksRun, passed, failed }, issues, correctionAttempts);
      }
      // A budget stop is FAILED, never ESCALATED. The router has permanently
      // marked this run over its hard cap, so every further generation fails
      // instantly — escalating would park the run for five minutes and offer a
      // "retry" that cannot possibly succeed, turning the hard kill the user
      // configured into a five-minute wait before the same answer.
      if (err instanceof Error && err.name === 'BudgetExceededError') {
        issues.push(errMsg);
        const stopped = output || errMsg;
        this.setStatus('FAILED', stopped);
        this.peerBus?.publish(this.id, assignment.subtaskId, stopped, 'FAILED');
        return this.buildResult('FAILED', stopped, { checksRun, passed, failed }, issues, correctionAttempts);
      }
      issues.push(`Execution error: ${errMsg}`);
      const finalOutput = output || errMsg;
      this.setStatus('FAILED', finalOutput);
      this.peerBus?.publish(this.id, assignment.subtaskId, finalOutput, 'FAILED');
      return this.buildResult('ESCALATED', finalOutput, { checksRun, passed, failed }, issues, correctionAttempts);
    }
  }

  sendToPeer(toId: string, content: unknown): void {
    this.peerBus?.send(this.id, toId, 'SHARE_OUTPUT', this.assignment?.subtaskId ?? '', content);
  }

  async requestFromPeer(peerId: string, subtaskId: string): Promise<string> {
    if (!this.peerBus) throw new Error('No PeerBus attached');
    const output = await this.peerBus.waitFor(subtaskId);
    return output.output;
  }

  async syncWithPeers(barrierName: string): Promise<void> {
    if (!this.peerBus) return;
    const total = this.peerBus.getMembers().length;
    await this.peerBus.barrier(this.id, barrierName, total);
  }

  receivePeerSync(fromId: string, content: unknown): void {
    this.peerSyncBuffer.push({ fromId, content, timestamp: new Date().toISOString() });
    this.emit('peer-sync-received', { fromId, content });
    
    // Notify the agent proactively so it doesn't have to guess when to poll
    this.context.addMessage({
      role: 'user',
      content: `[SYSTEM_NOTIFICATION]: You received a new peer message from ${fromId}. Use the "peer_message" tool with action="receive" to read it.`
    }).catch(() => {});
  }

  // ── Private ──────────────────────────────────

  private async runAgentLoop(
    systemPrompt: string,
    tools: ToolDefinition[],
  ): Promise<{ output: string; toolCalls: ToolCall[] }> {
    const allToolCalls: ToolCall[] = [];
    let iterations = 0;
    let stalledArtifactIterations = 0;
    const MAX_ITERATIONS = 15;
    const requiresArtifact = this.requiresArtifact();
    // `tools` is reassigned when a dynamic tool is created — must be a let
    tools = [...tools];

    // Cascade Auto: route this specific subtask to the benchmark-best model for
    // its type (coding → Claude, writing → GPT/Gemini, …). Returns null when
    // Cascade Auto is off, in which case the shared tier model is used.
    let subtaskModel: ModelInfo | undefined;
    try {
      const subtaskText = `${this.assignment?.subtaskTitle ?? ''} ${this.assignment?.description ?? ''} ${this.assignment?.expectedOutput ?? ''}`;
      // Tool-equipped subtasks prefer models with native tool support (the
      // text fallback still works when none is available).
      subtaskModel = (await this.router.selectModelForSubtask('T3', subtaskText, { requiresToolUse: tools.length > 0 })) ?? undefined;
      if (subtaskModel) {
        this.log(`Cascade Auto: routing this subtask to ${subtaskModel.provider}:${subtaskModel.id}`);
      }
    } catch { /* fall back to the tier model */ }

    // Detect tool-use mode against the EFFECTIVE model (per-subtask override if
    // any, else the tier default).
    const effectiveModel = subtaskModel ?? this.router.getModelForTier('T3');
    // Tag this node with the model actually serving it — including a Cascade
    // Auto per-subtask override — so the desktop can show model-per-task.
    if (effectiveModel) this.setServingModel(`${effectiveModel.provider}:${effectiveModel.id}`);
    const useTextTools = effectiveModel?.supportsToolUse === false && tools.length > 0;
    // Token economy for text-tool models: the FULL per-parameter contract goes
    // out only on the first call (and again whenever the tool list changes,
    // e.g. a dynamic tool was created mid-run — the system prompt is rebuilt
    // per call, so a new tool the model has never seen needs its contract).
    // Later iterations get a terse reminder; by then the history contains the
    // model's own well-formed <tool_call> examples.
    let sentFullTextContract = false;
    let textContractSignature = '';

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      // ── Cancellation checkpoint (before every LLM call) ──────────────
      this.throwIfCancelled();

      // ── Live steering: pick up user interventions before the next call ──
      const guidance = this.router.getGuidanceQueue?.()?.drain(this.id) ?? [];
      for (const g of guidance) {
        this.log(`User intervention received: ${g.text}`);
        this.sendStatusUpdate({ progressPct: 50, currentAction: 'Applying user intervention', status: 'IN_PROGRESS' });
        await this.context.addMessage({
          role: 'user',
          content: `USER INTERVENTION (mid-run steering — follow this over prior instructions where they conflict):\n${g.text}`,
        });
      }

      let textToolSuffix = '';
      if (useTextTools) {
        const signature = tools.map((t) => t.name).join(',');
        if (!sentFullTextContract || signature !== textContractSignature) {
          textToolSuffix = buildTextToolSystemPrompt(tools);
          sentFullTextContract = true;
          textContractSignature = signature;
        } else {
          textToolSuffix = buildTextToolReminder(tools);
        }
      }

      const options: GenerateOptions = {
        messages: this.context.getMessages(),
        systemPrompt: this.systemPromptOverride + systemPrompt
          + (this.hierarchyContext ? `\n\nHIERARCHY CONTEXT: ${this.hierarchyContext}` : '')
          + textToolSuffix,
        // Don't pass tools array when model can't use them natively
        tools: useTextTools ? undefined : (tools.length ? tools : undefined),
        maxTokens: 4096,
        ...(subtaskModel ? { model: subtaskModel } : {}),
        featureTag: this.assignment?.sectionTitle,
        ...(this.localOnlyMatch ? { forceLocal: true } : {}),
      };

      const result = await this.router.generate(
        'T3',
        options,
        (chunk) => {
          this.emit('stream:token', { tierId: this.id, text: chunk.text, primary: this.isPresenter });
        },
      );

      // For text-tool mode: parse <tool_call> blocks and inject as native tool calls
      let effectiveToolCalls = result.toolCalls ?? [];
      if (useTextTools && effectiveToolCalls.length === 0) {
        const textCalls = parseTextToolCalls(result.content);
        effectiveToolCalls = textCalls.map((tc, i) => toToolCall(tc, i));
      }
      const effectiveResult = { ...result, toolCalls: effectiveToolCalls };

      await this.context.addMessage({ role: 'assistant', content: result.content, toolCalls: effectiveToolCalls });

      if (!effectiveResult.toolCalls?.length) {
        if (requiresArtifact) {
          const artifactCheck = await this.verifyArtifacts(this.assignment!);
          if (artifactCheck.ok) {
            return { output: result.content, toolCalls: allToolCalls };
          }

          stalledArtifactIterations += 1;
          if (stalledArtifactIterations >= 2) {
            const partial = result.content || '';
            if (stalledArtifactIterations === 2) {
              throw new WorkerStallError(
                `Worker stalled waiting for artifact creation. Requesting dynamic tool generation from T2 Manager for: ${this.assignment?.subtaskTitle ?? 'unknown task'}`,
                partial,
              );
            }
            throw new WorkerStallError(
              'Artifact-producing task stalled without creating or verifying the required files',
              partial,
            );
          }
          await this.context.addMessage({
            role: 'user',
            content: `You have not yet created and verified the required artifact. Issues: ${artifactCheck.issues.join('; ')}. Use tools to create the file in the workspace, verify it exists, and inspect the result before concluding.`,
          });
          continue;
        }
        return { output: result.content, toolCalls: allToolCalls };
      }

      stalledArtifactIterations = 0;

      if (effectiveResult.finishReason === 'stop' && effectiveResult.toolCalls.length === 0) {
        if (requiresArtifact) {
          const artifactCheck = await this.verifyArtifacts(this.assignment!);
          if (artifactCheck.ok) {
            return { output: result.content, toolCalls: allToolCalls };
          }
        } else {
          return { output: result.content, toolCalls: allToolCalls };
        }
      }

      for (const tc of effectiveResult.toolCalls) {
        allToolCalls.push(tc);
        const toolResult = await this.executeTool(tc);
        // Bound what enters the context: the WHOLE history is re-sent on every
        // remaining iteration, so an unbounded tool result (big file read,
        // chatty command) multiplies into a token bomb across the loop.
        await this.context.addMessage({
          role: 'tool',
          content: truncateForContext(toolResult),
          toolCallId: tc.id,
        });
      }
    }

    const lastMsg = this.context.getMessages().slice().reverse().find((m) => m.role === 'assistant');
    return {
      output: typeof lastMsg?.content === 'string' ? lastMsg.content : '',
      toolCalls: allToolCalls,
    };
  }

  /**
   * Lightweight argument check against the tool's JSON Schema: required fields
   * present and enum values in range. Not a full validator — just the two
   * failure modes weak models hit most. Returns an error message, or null if OK.
   */
  private validateToolInput(tc: ToolCall): string | null {
    const def = this.tools.find(t => t.name === tc.name);
    const schema = def?.inputSchema as {
      properties?: Record<string, { enum?: unknown[] }>;
      required?: string[];
    } | undefined;
    if (!schema) return null;

    const required = Array.isArray(schema.required) ? schema.required : [];
    const missing = required.filter(k => tc.input[k] === undefined || tc.input[k] === null || tc.input[k] === '');
    if (missing.length) {
      return `Tool error: missing required parameter(s) for "${tc.name}": ${missing.join(', ')}. Expected: ${JSON.stringify(schema)}. Supply them and call the tool again.`;
    }

    if (schema.properties) {
      for (const [k, prop] of Object.entries(schema.properties)) {
        const allowed = Array.isArray(prop?.enum) ? prop.enum : null;
        if (allowed && tc.input[k] !== undefined && !allowed.includes(tc.input[k])) {
          return `Tool error: invalid value for "${k}" in "${tc.name}": ${JSON.stringify(tc.input[k])}. Must be one of ${JSON.stringify(allowed)}.`;
        }
      }
    }
    return null;
  }

  private async executeTool(tc: ToolCall): Promise<string> {
    // T3→T2 reinforcement: handle locally (record the request for the manager) —
    // it is a signal, not a real side-effecting tool, so it skips registry
    // validation and approval.
    if (tc.name === 'request_workers') {
      const msg = this.recordReinforcements(tc.input);
      this.emit('tool:result', { id: tc.id, tierId: this.id, toolName: tc.name, output: msg, durationMs: 0 });
      return msg;
    }

    // Reject malformed calls early (before any approval prompt) with a clear,
    // self-correcting message — weaker models often omit required parameters or
    // pass an out-of-range enum value, which otherwise fails opaquely at run time.
    const validationError = this.validateToolInput(tc);
    if (validationError) {
      this.emit('tool:result', { id: tc.id, tierId: this.id, toolName: tc.name, error: validationError, durationMs: 0 });
      return validationError;
    }

    const needsApproval = this.toolRegistry.requiresApproval(tc.name);

    if (needsApproval) {
      // ── Hierarchical permission escalation: T3 → T2 → T1 → User ──
      if (this.permissionEscalator) {
        const req: PermissionRequest = {
          id: `${this.id}-${tc.id}`,
          requestedBy: this.id,
          parentT2Id: this.parentId ?? 'root',
          toolName: tc.name,
          input: tc.input,
          isDangerous: this.toolRegistry.isDangerous(tc.name),
          subtaskContext: this.assignment?.subtaskTitle ?? 'Unknown subtask',
          sectionContext: this.assignment?.subtaskTitle ?? 'Unknown section',
        };
        const decision = await this.permissionEscalator.requestPermission(req);
        if (!decision.approved) return `Tool ${tc.name} was denied (decided by ${decision.decidedBy}).`;
      } else {
        // ── Fallback: legacy direct approval event (used when escalator not wired) ──
        if (this.sessionApprovals.has(tc.name)) {
          const wasApproved = this.sessionApprovals.get(tc.name)!;
          if (!wasApproved) return `Tool ${tc.name} was denied by user.`;
        } else {
          // Time-box this fallback too (default 10 min → deny) so a missing or
          // unanswered approval prompt can't hang the worker indefinitely.
          const LEGACY_APPROVAL_TIMEOUT_MS = 600_000;
          const legacyDecision = await new Promise<{ approved: boolean; always?: boolean }>((resolve) => {
            const eventName = `tool:approval-response:${this.id}-${tc.id}`;
            const timer = setTimeout(() => {
              this.removeAllListeners(eventName);
              resolve({ approved: false });
            }, LEGACY_APPROVAL_TIMEOUT_MS);
            timer.unref?.();
            this.emit('tool:approval-request', {
              id: `${this.id}-${tc.id}`,
              tierId: this.id,
              toolName: tc.name,
              input: tc.input,
              description: `T3 (${this.assignment?.subtaskTitle}) wants to run "${tc.name}"`,
              isDangerous: this.toolRegistry.isDangerous(tc.name),
            });
            this.once(eventName, (d: { approved: boolean; always?: boolean }) => {
              clearTimeout(timer);
              resolve(d);
            });
          });
          if (legacyDecision.always) this.sessionApprovals.set(tc.name, legacyDecision.approved);
          if (!legacyDecision.approved) return `Tool ${tc.name} was denied by user.`;
        }
      }
    }

    // Emit tool:use before execution so the TUI can display the active tool
    this.sendStatusUpdate({
      progressPct: 50,
      currentAction: `Using tool: ${tc.name}`,
      status: 'IN_PROGRESS',
    });

    this.emit('tool:call', { id: tc.id, tierId: this.id, toolName: tc.name, input: tc.input });
    const toolStartMs = Date.now();

    try {
      const result = await this.toolRegistry.execute(tc.name, tc.input, {
        tierId: this.id,
        sessionId: this.taskId,
        requireApproval: false,
        // Media generation can run for a minute; without this a cancelled run
        // still pays for an image nobody will see.
        ...(this.signal ? { signal: this.signal } : {}),
        saveSnapshot: async (path, content) => {
          this.store?.addFileSnapshot(this.taskId, path, content);
        },
        sendPeerSync: (to, syncType, content) => {
          this.peerBus?.send(this.id, to, syncType, this.assignment?.subtaskId ?? '', content);
        },
        getPeerMessages: () => {
          const msgs = [...this.peerSyncBuffer];
          this.peerSyncBuffer = [];
          return msgs;
        },
      });
      if (this.audit) {
        this.audit.toolCall(this.id, tc.name, tc.input);
        if (this.isFileOperation(tc.name)) {
          this.audit.fileChange(this.id, (tc.input['path'] as string | undefined) ?? 'unknown', tc.name);
        }
      }
      const durationMs = Date.now() - toolStartMs;
      this.emit('tool:result', { id: tc.id, tierId: this.id, toolName: tc.name, output: typeof result === 'string' ? result : JSON.stringify(result), durationMs });
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (err) {
      const durationMs = Date.now() - toolStartMs;
      const errMsg = err instanceof Error ? err.message : String(err);
      this.emit('tool:result', { id: tc.id, tierId: this.id, toolName: tc.name, error: errMsg, durationMs });
      // Unrecoverable/systemic conditions (rate-limit, auth, quota, AND a 404
      // "model not found" — the shared classifier this reuses is the same one
      // `router/index.ts` uses for chat-tier failover, so a dead image model
      // or any other systemic provider failure is fast-failed here too rather
      // than falling through to adaptiveFallback and looping (previously up
      // to 15× before ever emitting the real reason). A tool can also mark its
      // OWN failure systemic directly (e.g. web_search when every backend is
      // down — that will fail identically for every worker in this run, not
      // just this one subtask) without needing to fit the provider-error shape.
      //
      // classifyProviderError is only consulted for PROVIDER_BACKED_TOOLS.
      // Its message-text patterns are calibrated for LLM/media-provider
      // vocabulary, and applying it to every tool's error indiscriminately
      // misfires on unrelated local failures that happen to share words with
      // that vocabulary — e.g. a plain filesystem `EACCES: permission denied`
      // from file_read matches the auth-failure pattern and would otherwise
      // escalate the whole worker instead of letting it try a different file.
      const isTaggedSystemic = err instanceof Error && (err as Error & { systemic?: boolean }).systemic === true;
      const isProviderBacked = PROVIDER_BACKED_TOOLS.has(tc.name);
      if (isTaggedSystemic || (isProviderBacked && classifyProviderError(err).systemic)) {
        throw new CriticalToolError(errMsg, tc.name);
      }
      // A provider-backed GENERATION call that failed for a NON-systemic reason
      // stops here too, and this is the one case where "stop" costs less than
      // "try again". generate-media.ts's runWithProviderFallback already settled
      // the retry question for these tools with the alternatives in hand: a
      // systemic failure is retried once per alternate provider, and a
      // non-systemic one (content refusal, malformed prompt, a render that blew
      // past its deadline) is deliberately NOT retried, because it would very
      // plausibly fail the same way again while costing another billed call. By
      // the time the error reaches here that decision has been made — and
      // adaptiveFallback was quietly re-opening it with a mechanism built for a
      // completely different problem (a wrong or missing tool NAME). For
      // generate_video that meant either a keyword-similar substitution
      // (generate_image "recovering" a video request), a synthesized replacement
      // tool, or an error string the agent loop answers by calling the same
      // 8-minute render again — the "thirty minutes and no video" burn.
      // Failing the subtask on the first attempt, with the real reason intact,
      // is both cheaper and more honest.
      if (isProviderBacked) {
        throw new CriticalToolError(
          `${tc.name} failed and was not retried — media generation is billed per attempt, `
          + `so Cascade stops on the first failure instead of paying for a second. Reason: ${errMsg}`,
          tc.name,
        );
      }
      // Try to recover via a sibling tool or a synthesized one before giving up;
      // returns the original error string if no fallback succeeds.
      return await this.adaptiveFallback(tc, `Tool error: ${errMsg}`);
    }
  }

  /**
   * Adaptive fallback cascade — invoked when executeTool() fails.
   * Strategy order:
   *   1. Find a semantically similar registered tool and retry with same input
   *   2. Synthesize a new tool via ToolCreator (if available) and run it
   *   3. Return the original error so the agent loop can decide what to do next
   *
   * Scoped to CHEAP, task-scoped failures — the class of problem it was built
   * for is a wrong or missing tool name, where a name-similar sibling plausibly
   * does the same job for the same (near-zero) cost. PROVIDER_BACKED_TOOLS never
   * reach it: their siblings are keyword-similar but semantically different
   * (generate_image is not a stand-in for generate_video), and every attempt —
   * theirs, or a synthesized replacement's — is separately billed. See the
   * fast-fail branch in executeTool().
   */
  private async adaptiveFallback(tc: ToolCall, originalError: string): Promise<string> {
    // Strategy 1: alternative tool with overlapping purpose
    const altTool = this.findAlternativeTool(tc.name);
    if (altTool) {
      this.log(`Adaptive fallback: trying alternative tool "${altTool}" for failed "${tc.name}"`);
      this.sendStatusUpdate({ progressPct: 50, currentAction: `Fallback: trying ${altTool}`, status: 'IN_PROGRESS' });
      try {
        const result = await this.toolRegistry.execute(altTool, tc.input, {
          tierId: this.id,
          sessionId: this.taskId,
          requireApproval: false,
          ...(this.signal ? { signal: this.signal } : {}),
        });
        const str = typeof result === 'string' ? result : JSON.stringify(result);
        if (!str.startsWith('Tool error:') && !str.startsWith('Error:')) {
          return `[Fallback via ${altTool}]: ${str}`;
        }
      } catch { /* fall through to next strategy */ }
    }

    // Strategy 2: synthesize a new tool via ToolCreator
    if (this.toolCreator) {
      this.log(`Adaptive fallback: requesting dynamic tool synthesis for "${tc.name}"`);
      this.sendStatusUpdate({ progressPct: 55, currentAction: `Synthesizing fallback tool for: ${tc.name}`, status: 'IN_PROGRESS' });
      try {
        const newToolName = await this.toolCreator.createTool(
          `Replacement for "${tc.name}" — original failed with: ${originalError.slice(0, 150)}`,
          this.assignment?.subtaskTitle ?? tc.name,
        );
        if (newToolName) {
          this.log(`Adaptive fallback: synthesized "${newToolName}", retrying`);
          const result = await this.toolRegistry.execute(newToolName, tc.input, {
            tierId: this.id,
            sessionId: this.taskId,
            requireApproval: false,
            ...(this.signal ? { signal: this.signal } : {}),
          });
          const str = typeof result === 'string' ? result : JSON.stringify(result);
          if (!str.startsWith('Tool error:')) return `[Synthesized ${newToolName}]: ${str}`;
        }
      } catch { /* fall through */ }
    }

    return originalError;
  }

  /**
   * Find a registered tool whose name/description semantically overlaps with
   * the failing tool. Returns the best candidate name, or null if none found.
   */
  private findAlternativeTool(failedToolName: string): string | null {
    const failedKeywords = failedToolName.toLowerCase().split(/[_\-\s]+/);
    const allTools = this.toolRegistry.getToolDefinitions();
    let bestScore = 0;
    let bestName: string | null = null;

    for (const tool of allTools) {
      if (tool.name === failedToolName) continue;
      const toolWords = tool.name.toLowerCase().split(/[_\-\s]+/);
      const score = failedKeywords.filter(k => toolWords.includes(k)).length;
      if (score > bestScore && score >= 1) {
        bestScore = score;
        bestName = tool.name;
      }
    }
    return bestName;
  }

  /**
   * Announce which files this T3 plans to edit, then acquire locks on them
   * before competing siblings can claim them. T3s working on different files
   * proceed in full parallel; T3s on the same file serialize automatically.
   */
  private async coordinateFileIntents(assignment: T2ToT3Assignment): Promise<void> {
    if (!this.peerBus) return;
    // Only coordinate locks for tasks that will actually WRITE files. A read or
    // analyze task that merely mentions a filename in prose (e.g. "is the README
    // a novel idea?") must not lock it — locking phantom or read-only paths
    // previously caused waits that could stall the whole run for minutes.
    const haystack = `${assignment.description}\n${assignment.expectedOutput}`;
    if (!/\b(create|write|save|generate|produce|output|edit|update|modify|append|overwrite|rewrite)\b/i.test(haystack)) {
      return;
    }
    const plannedFiles = this.extractArtifactPaths(assignment);
    if (!plannedFiles.length) return;

    // Broadcast intent so siblings are aware
    this.peerBus.broadcast(this.id, {
      type: 'FILE_INTENT',
      subtaskId: assignment.subtaskId,
      files: plannedFiles,
    });

    // Give siblings 500ms to announce their intents
    await new Promise(r => setTimeout(r, 500));

    // Acquire locks on all planned files (deterministic order to avoid deadlock).
    // Lock coordination is best-effort and time-boxed: a stuck or never-released
    // lock must never hang the actual work, so any wait failure falls through to
    // proceeding without the lock.
    const sortedFiles = [...plannedFiles].sort();
    for (const filePath of sortedFiles) {
      try {
        if (this.peerBus.isFileLocked(filePath)) {
          this.log(`[T3] Waiting for file lock: ${filePath}`);
          this.sendStatusUpdate({
            progressPct: 5,
            currentAction: `Waiting for peer to finish editing: ${filePath}`,
            status: 'IN_PROGRESS',
          });
          await this.peerBus.waitForFileRelease(filePath, 10_000).catch(() => { /* proceed unlocked */ });
        }
        await this.peerBus.lockFile(this.id, filePath, 10_000).catch(() => { /* proceed unlocked */ });
      } catch (err) {
        this.log(`[T3] Lock coordination skipped for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Register cleanup: release all locks when this worker finishes
    const origPublish = this.peerBus.publish.bind(this.peerBus);
    const bus = this.peerBus;
    const workerId = this.id;
    const cleanup = () => {
      for (const f of sortedFiles) bus.releaseFile(workerId, f);
    };
    this.once('completed', cleanup);
    this.once('failed', cleanup);
    this.peerBus.publish = (fromId, subtaskId, output, status) => {
      if (fromId === this.id) cleanup();
      // Restore original after first call for this worker
      this.peerBus!.publish = origPublish;
      origPublish(fromId, subtaskId, output, status);
    };
  }

  private requiresArtifact(): boolean {
    return shouldRequireArtifact(this.assignment, this.tools.map((t) => t.name));
  }

  private extractArtifactPaths(assignment: T2ToT3Assignment): string[] {
    // Spec-declared files verify deterministically; regex over the prose is
    // the fallback for plans that didn't declare them.
    const declared = (assignment.files ?? []).map((f) => f.trim()).filter((f) => f.includes('.'));
    const haystack = `${assignment.description}
${assignment.expectedOutput}`;
    const matches = haystack.match(new RegExp(ARTIFACT_FILE_RE.source, 'gi')) ?? [];
    return [...new Set([...declared, ...matches.map((m) => m.trim())])];
  }

  private async verifyArtifacts(assignment: T2ToT3Assignment): Promise<{ ok: boolean; issues: string[] }> {
    const artifactPaths = this.extractArtifactPaths(assignment);
    if (!artifactPaths.length) return { ok: true, issues: [] };

    const issues: string[] = [];
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);

    for (const artifactPath of artifactPaths) {
      const absolutePath = path.resolve(process.cwd(), artifactPath);
      try {
        const stat = await fs.stat(absolutePath);
        if (!stat.isFile()) {
          issues.push(`Expected artifact is not a file: ${artifactPath}`);
          continue;
        }
        if (stat.size <= 0) {
          issues.push(`Artifact is empty: ${artifactPath}`);
          continue;
        }

        // Office formats are ZIP archives of XML: a valid one starts with the
        // "PK\x03\x04" local-file signature. Checking that is what catches the
        // original bug — Markdown written straight into `report.docx` is a
        // perfectly non-empty file that Word refuses to open — and reading such
        // a file as utf-8 would have declared it fine.
        if (/\.(docx|pptx|xlsx)$/i.test(artifactPath)) {
          const head = Buffer.alloc(4);
          const fh = await fs.open(absolutePath, 'r');
          try {
            await fh.read(head, 0, 4, 0);
          } finally {
            await fh.close();
          }
          if (head.toString('latin1') !== 'PK\x03\x04') {
            issues.push(
              `${artifactPath} is not a valid Office file — it must be written with the generate_document tool, `
              + 'which renders the real OOXML archive. Plain text saved under that extension opens as corrupted.',
            );
            continue;
          }
        } else if (!/\.pdf$/i.test(artifactPath)) {
          const content = await fs.readFile(absolutePath, 'utf-8');
          if (!content.trim()) {
            issues.push(`Artifact content is empty: ${artifactPath}`);
            continue;
          }
        } else if (stat.size < 100) {
          issues.push(`PDF artifact looks too small to be valid: ${artifactPath}`);
          continue;
        }

        // Semantic checks
        const ext = path.extname(absolutePath).toLowerCase();
        try {
          if (ext === '.ts' || ext === '.tsx') {
            await execAsync(`npx tsc --noEmit ${absolutePath}`, { timeout: 10000 });
          } else if (ext === '.js' || ext === '.jsx') {
            await execAsync(`node --check ${absolutePath}`, { timeout: 10000 });
          } else if (ext === '.py') {
            await execAsync(`python -m py_compile ${absolutePath}`, { timeout: 10000 });
          }
        } catch (err: any) {
          const stderr = err?.stderr || String(err);
          const stdout = err?.stdout || '';
          issues.push(`Semantic error in ${artifactPath}:\n${stderr}\n${stdout}`);
        }
      } catch {
        issues.push(`Required artifact was not created: ${artifactPath}`);
      }
    }

    return { ok: issues.length === 0, issues };
  }

  /**
   * Reflection / self-critique: critique the output against the broader GOAL
   * (not just the subtask spec the self-test checks) and revise once if it falls
   * short. Two cheap calls per round — a JSON verdict, then a rewrite only if
   * needed. Best-effort: any parse/error just keeps the current output.
   */
  private async reflectAndImprove(
    assignment: T2ToT3Assignment,
    output: string,
    maxRounds: number,
  ): Promise<string> {
    let current = output;
    try {
      for (let round = 0; round < Math.max(1, maxRounds); round++) {
        // Independent critic: one direct call routed to the T2-tier model — a
        // DIFFERENT model than the T3 that produced the output, so it isn't
        // grading its own work. Deliberately not a spawned T2Manager: a full
        // manager decomposes the critique into its own T3 subtasks (costing
        // more than the work under review), and those critic-spawned workers
        // would hit this very reflection step again — unbounded recursion.
        const verdictResult = await this.router.generate('T2', {
          messages: [{
            role: 'user',
            content: `You are an independent critic reviewing another worker's output against its assignment.

Goal: ${assignment.expectedOutput}
Subtask: ${assignment.description}
Current Output:
${current}

Is this output sufficient and correct? Respond with ONLY a JSON object:
{"sufficient": true|false, "notes": "what is wrong or missing if false"}`,
          }],
          systemPrompt: 'You are a T2-Critic reviewing a T3 Worker\'s output. Judge strictly against the stated goal.',
          maxTokens: 400,
          signal: this.signal,
          featureTag: assignment.sectionTitle,
          ...(this.localOnlyMatch ? { forceLocal: true } : {}),
        });

        const match = /\{[\s\S]*\}/.exec(verdictResult.content);
        const parsed = (match ? JSON.parse(match[0]) : { sufficient: true }) as { sufficient?: boolean; notes?: string };

        if (parsed.sufficient !== false) {
          this.log('T2-Critic approved output.');
          break; // sufficient
        }

        this.log(`T2-Critic rejected output: ${parsed.notes}`);
        
        const improved = await this.router.generate('T3', {
          messages: [{
            role: 'user',
            content: `Improve the following so it fully achieves the goal. Address specifically: ${parsed.notes ?? 'gaps vs the goal'}.
Output ONLY the improved result — no preamble, no commentary.

Goal / expected: ${assignment.expectedOutput}

Current output:
${current}`,
          }],
          systemPrompt: this.systemPromptOverride + (this.hierarchyContext ? `\n\nHIERARCHY CONTEXT: ${this.hierarchyContext}` : ''),
          maxTokens: 4096,
          featureTag: assignment.sectionTitle,
          ...(this.localOnlyMatch ? { forceLocal: true } : {}),
        });
        const next = (improved.content ?? '').trim();
        if (!next) break;
        current = next;
        this.log('Reflection: revised output for better goal alignment.');
      }
    } catch (e) {
      this.log(`T2-Critic reflection failed: ${e}`);
    }
    return current;
  }

  /**
   * Run the acceptance criteria that can be settled by looking at the workspace.
   * Reads go through the same workspace-relative resolution verifyArtifacts uses.
   */
  private async checkAcceptance(assignment: T2ToT3Assignment): Promise<AcceptanceResult[]> {
    const criteria = assignment.acceptance ?? [];
    if (!criteria.length) return [];
    const resolve = (target: string) => path.resolve(process.cwd(), target);
    return evaluateAcceptance(criteria, assignment.files ?? [], {
      stat: async (target) => {
        try {
          const stat = await fs.stat(resolve(target));
          return stat.isFile() ? { size: stat.size } : null;
        } catch { return null; }
      },
      read: async (target) => {
        try {
          const content = await fs.readFile(resolve(target), 'utf-8');
          // A binary file read as utf-8 comes back full of replacement chars;
          // treating that as text would make "contains" answer nonsense.
          // U+FFFD is what a binary byte sequence decodes to as utf-8; treating
          // such a file as text would make a "contains" check answer nonsense.
          return content.includes('\uFFFD') ? null : content;
        } catch { return null; }
      },
    });
  }

  private async selfTest(
    assignment: T2ToT3Assignment,
    output: string,
    /**
     * Only the criteria the deterministic rung could not settle. Re-grading one
     * that stat already decided invites the model to overturn a fact.
     */
    pendingAcceptance?: readonly string[],
  ): Promise<{ checksRun: string[]; passed: string[]; failed: string[] }> {
    const acceptance = pendingAcceptance ?? assignment.acceptance ?? [];
    const prompt = `Self-test this output against the assignment requirements.

Assignment: ${assignment.description}
Expected output: ${assignment.expectedOutput}
Constraints: ${assignment.constraints.join('; ')}
${acceptance.length ? `Acceptance criteria — ALL must be satisfied for "completeness" to pass:
${acceptance.map((a) => `- ${a}`).join('\n')}
` : ''}
Output to test:
${output}

Reply with JSON: { "completeness": "pass"|"fail", "correctness": "pass"|"fail", "compliance": "pass"|"fail", "notes": "string" }`;

    const testMessages: ConversationMessage[] = [{ role: 'user', content: prompt }];
    const testResult = await this.router.generate('T3', {
      messages: testMessages,
      maxTokens: 500,
      systemPrompt: this.systemPromptOverride + (this.hierarchyContext ? `\n\nHIERARCHY CONTEXT: ${this.hierarchyContext}` : ''),
      featureTag: assignment.sectionTitle,
      ...(this.localOnlyMatch ? { forceLocal: true } : {}),
    });

    try {
      const jsonMatch = /\{[\s\S]*\}/.exec(testResult.content);
      if (!jsonMatch) throw new Error('No JSON in test result');
      const parsed = JSON.parse(jsonMatch[0]) as {
        completeness: string;
        correctness: string;
        compliance: string;
        notes: string;
      };

      const checksRun = ['completeness', 'correctness', 'compliance'];
      const passed = checksRun.filter((c) => parsed[c as keyof typeof parsed] === 'pass');
      const failed = checksRun.filter((c) => parsed[c as keyof typeof parsed] === 'fail');

      return { checksRun, passed, failed };
    } catch {
      // Fail CLOSED, not open. This used to report all three checks as
      // passing whenever the grading call itself threw or its response
      // didn't parse — silently treating a broken grader as a clean pass, on
      // a section that may well have nothing behind it (e.g. a worker that
      // hit a hard tool failure and never produced grounded output). Bounded
      // the same way an ordinary failed check is: one correction attempt and
      // one retest (see execute()'s testResult.failed handling), not a loop.
      return {
        checksRun: ['completeness', 'correctness', 'compliance'],
        passed: [],
        failed: ['completeness'],
      };
    }
  }

  /**
   * world-state v2: distill a completed subtask's output into durable
   * `(entity, relation, value)` facts and upsert them into the knowledge graph.
   * A bounded, cheap T3-tier call; entirely best-effort — any failure is swallowed
   * so it never blocks or fails the subtask. Respects the subtask's privacy tier
   * (a local-only subtask extracts on a local model too, never leaking to cloud).
   */
  private async extractAndStoreFacts(db: WorldStateDB, assignment: T2ToT3Assignment, output: string): Promise<void> {
    try {
      const prompt = `Extract durable project facts from this completed subtask.
Return ONLY a JSON array of {"entity","relation","value"} triples describing lasting
facts about the codebase/project — e.g. {"entity":"auth module","relation":"uses","value":"JWT"}.
Ignore transient step-by-step details. At most 6 triples. If nothing durable, return [].

Subtask: ${assignment.subtaskTitle}
Output:
${output.slice(0, 4000)}`;
      const result = await this.router.generate('T3', {
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 300,
        temperature: 0,
        ...(this.localOnlyMatch ? { forceLocal: true } : {}),
      });
      const match = /\[[\s\S]*\]/.exec(result.content);
      if (!match) return;
      const facts = JSON.parse(match[0]);
      if (!Array.isArray(facts)) return;
      for (const f of facts.slice(0, 8)) {
        if (f && typeof f.entity === 'string' && typeof f.relation === 'string' && typeof f.value === 'string') {
          db.upsertFact(f.entity, f.relation, f.value, this.id);
        }
      }
    } catch {
      // Best-effort — extraction never blocks the run.
    }
  }

  private async correctOutput(originalOutput: string, failures: string[]): Promise<string> {
    const correctionPrompt = `The following output failed these checks: ${failures.join(', ')}.

Original output:
${originalOutput}

Correct the issues and provide an improved version that addresses all failures.`;

    await this.context.addMessage({ role: 'user', content: correctionPrompt });

    const result = await this.runAgentLoop(
      "You are in a correction phase. Fix the identified issues using your tools." + (this.hierarchyContext ? `\n\nHIERARCHY CONTEXT: ${this.hierarchyContext}` : ''),
      this.tools
    );
    return result.output;
  }

  private buildSystemPrompt(assignment: T2ToT3Assignment): string {
    const available = new Set(this.toolRegistry.getToolDefinitions().map((t) => t.name));
    return `${buildWorkerRules((name) => available.has(name))}

Your subtask:
- Title: ${assignment.subtaskTitle}
- Description: ${assignment.description}
- Expected output: ${assignment.expectedOutput}
- Constraints: ${assignment.constraints.join('; ')}${assignment.files?.length ? `
- Files you own (create/edit ONLY these): ${assignment.files.join(', ')}` : ''}${assignment.acceptance?.length ? `
- Definition of done: ${assignment.acceptance.join('; ')}` : ''}`;
  }

  private buildInitialPrompt(assignment: T2ToT3Assignment): string {
    // Spec-slice prompt: with a contextBrief, the worker gets exactly the
    // background the planner chose for it — small, self-sufficient, and
    // executable by small models without the rest of the task in context.
    return `Execute the following subtask completely:

**${assignment.subtaskTitle}**
${assignment.contextBrief ? `
Context: ${assignment.contextBrief}
` : ''}
${assignment.description}

Expected output: ${assignment.expectedOutput}
${assignment.files?.length ? `
Files you own (create or edit exactly these paths):
${assignment.files.map((f) => `- ${f}`).join('\n')}
` : ''}${assignment.acceptance?.length ? `
Definition of done (your output must satisfy ALL of these):
${assignment.acceptance.map((a) => `- ${a}`).join('\n')}
` : ''}
Constraints:
${assignment.constraints.map((c) => `- ${c}`).join('\n')}

Begin execution now.`;
  }

  /**
   * Records a request_workers call (T3→T2 reinforcement). Capped at
   * maxPerSection; reinforcement workers (depth 1) cannot request more.
   */
  private recordReinforcements(input: Record<string, unknown>): string {
    if (this.reinforcementDepth !== 0) {
      return 'request_workers is unavailable to reinforcement workers — complete your assigned subtask.';
    }
    const max = this.router.getReinforcementsConfig?.()?.maxPerSection ?? 4;
    const raw = Array.isArray((input as { subtasks?: unknown }).subtasks)
      ? (input as { subtasks: unknown[] }).subtasks
      : [];
    let added = 0;
    for (const s of raw) {
      if (this.pendingReinforcements.length >= max) break;
      const o = s as { title?: unknown; description?: unknown; expectedOutput?: unknown };
      if (typeof o?.title !== 'string' || typeof o?.description !== 'string') continue;
      this.pendingReinforcements.push({
        subtaskId: `reinf-${this.id}-${this.pendingReinforcements.length + 1}`,
        subtaskTitle: o.title,
        description: o.description,
        expectedOutput: typeof o.expectedOutput === 'string' ? o.expectedOutput : o.title,
        constraints: [],
        peerT3Ids: [],
        parentT2: this.parentId ?? 'root',
        dependsOn: [],
      });
      added++;
    }
    return added > 0
      ? `Requested ${added} reinforcement worker(s) from your manager; they will run in parallel. Focus on your own part — do not redo their work.`
      : 'No valid reinforcement subtasks (each needs a title and description), or the per-section limit was reached.';
  }

  private buildResult(
    status: T3Result['status'],
    output: string,
    testResults: T3Result['testResults'],
    issues: string[],
    correctionAttempts: number,
  ): T3Result {
    return {
      subtaskId: this.assignment?.subtaskId ?? '',
      status,
      output,
      testResults,
      issues,
      peerSyncsUsed: this.peerSyncBuffer.map(m => m.fromId),
      correctionAttempts,
      localOnly: this.localOnlyMatch || undefined,
      reinforcements: this.pendingReinforcements.length ? this.pendingReinforcements : undefined,
    };
  }

  private isFileOperation(toolName: string): boolean {
    return ['file_write', 'file_edit', 'file_delete'].includes(toolName);
  }
}
