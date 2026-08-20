// ─────────────────────────────────────────────
//  Cascade AI — capability-aware plan spec shape
// ─────────────────────────────────────────────

/**
 * The parts of a planning prompt that describe what a subtask's `files` and
 * `acceptance` fields should contain.
 *
 * This exists because T1 and T2 are both planners asking for the same schema,
 * in two prompts written months apart, and both hard-coded a file-and-shell
 * shape: `"files": ["package.json"]`, `"acceptance": ["package.json exists and
 * parses as JSON"]`, a worked example that runs `npm init`, and a contextBrief
 * asserting "npm available". A hosted run has none of that — cloud/server's
 * run config enables `web_search` and `web_fetch` and nothing else, so no tool
 * in the registry can create a file or run a command — yet the planner was
 * still shown that example and dutifully copied it. Sections named "Project
 * Scaffolding" and subtasks named "Create Project Directory Structure" are
 * what came back, and none of them could ever be done.
 *
 * The system prompts on both tiers were already capability-aware
 * (`buildT1SystemPrompt`, `buildT2SystemPrompt`, `buildWorkerRules`). The USER
 * prompts, which carry the actual schema and the example, were not — and a
 * worked example beats a system-prompt sentence every time.
 *
 * One module, two callers, so the next change to either lands on both.
 */
export interface PlanSpecShape {
  /**
   * What the `files` field should contain — the prose only, with no field
   * label. T1 and T2 render the same sentence behind different labels
   * (`- "files": …` vs `- files: string[] …`), so the guidance is stored once
   * and each tier adds its own label. Storing two pre-labelled strings is how
   * they drifted in the first place.
   */
  filesGuidance: string;
  /** What the `acceptance` field should contain, prose only. See filesGuidance. */
  acceptanceGuidance: string;
  /** `files` value for a worked JSON example, already JSON-encoded. */
  exampleFiles: string;
  /** `acceptance` value for a worked JSON example, already JSON-encoded. */
  exampleAcceptance: string;
  /** Title/description/expectedOutput/contextBrief for a worked example subtask. */
  exampleSubtaskTitle: string;
  exampleDescription: string;
  exampleExpectedOutput: string;
  exampleContextBrief: string;
  /**
   * Extra paragraph for the top of a planning prompt, or '' when there is
   * nothing to add. Non-empty only when the run cannot write files, where the
   * planner needs telling before it starts inventing directories.
   */
  preamble: string;
}

const WITH_FILES: PlanSpecShape = {
  filesGuidance:
    'the exact relative paths the subtask creates or edits. Never vague ("some files"); always concrete.',
  acceptanceGuidance:
    '1-3 checks a reviewer could verify mechanically (file exists / contains X / command exits 0). These define done.',
  exampleFiles: '["package.json"]',
  exampleAcceptance: '["package.json exists and parses as JSON"]',
  exampleSubtaskTitle: 'Init NPM',
  exampleDescription: 'Run npm init',
  exampleExpectedOutput: 'package.json created',
  exampleContextBrief: 'Fresh Node 20 project; npm available.',
  preamble: '',
};

const WITHOUT_FILES: PlanSpecShape = {
  filesGuidance:
    'leave EMPTY ([]). This run has no tool that can create or edit a file, so no subtask owns a path.',
  acceptanceGuidance:
    '1-3 checks a reviewer could verify by READING THE WRITTEN ANSWER — what it must state, name, '
    + 'compare or quantify (e.g. "names at least three approaches with a trade-off for each", "states a single '
    + 'recommendation and the reason for it"). These define done. NEVER phrase one as a file existing, a path being '
    + 'created, or a command exiting 0: nothing on this run can make those true, and a worker that cannot satisfy a '
    + 'criterion fails the subtask no matter how good its answer is.',
  exampleFiles: '[]',
  exampleAcceptance: '["names each library considered and gives one reason for and against it"]',
  exampleSubtaskTitle: 'Compare the candidate libraries',
  exampleDescription: 'Research the available options and compare them on the criteria that matter for this task',
  exampleExpectedOutput: 'A written comparison of the candidates with a recommendation',
  exampleContextBrief: 'Node 20 project; the reader knows JavaScript but not this library space.',
  preamble:
    'ENVIRONMENT: this run has NO file, shell, or code-execution tools — the worker can read and write nothing on '
    + 'disk. Its written answer IS the deliverable. Plan work that is DONE by producing text: research, analysis, '
    + 'comparison, explanation, a written design, or source code quoted in the answer itself. Do NOT plan a subtask '
    + 'whose completion depends on creating a directory, scaffolding a project, saving a file, installing a package, '
    + 'or running a command — those cannot happen here, and a subtask that requires one fails however well the '
    + 'worker performs.',
};

/**
 * No worker-addressable disk, but the run can still finish a real asset.
 *
 * Generation tools register outside `enabledTools` (cascade.ts
 * registerMediaTools), so "no file tools" and "text is the only possible
 * output" are different facts about a hosted run, and WITHOUT_FILES asserted
 * the second from the first. On a run with `generate_video` that put this
 * user prompt — "its written answer IS the deliverable", "work that is DONE by
 * producing text" — directly against the system prompt's MEDIA GENERATION
 * block, which says the tool call IS the deliverable and cannot be satisfied
 * in words. The planner then has to pick one, and the failure mode that block
 * exists to prevent is exactly the one it picks: a script, a storyboard, and
 * no subtask that ever calls the tool.
 *
 * Everything else about the shape is unchanged — still `files: []`, still no
 * filesystem acceptance — because a generation tool hands its result back as a
 * location string in the worker's answer, not as a path this run can stat.
 */
const WITHOUT_FILES_WITH_GENERATORS: PlanSpecShape = {
  ...WITHOUT_FILES,
  preamble:
    'ENVIRONMENT: this run has NO file, shell, or code-execution tools — the worker can read and write nothing on '
    + 'disk. Its deliverables are what it writes in the answer itself AND whatever its generation tools return: '
    + 'plan work that is DONE by producing text — research, analysis, comparison, explanation, a written design, '
    + 'source code quoted in the answer — or by a generation tool returning a finished asset. Where this run has '
    + 'such a tool, that call IS the deliverable and a subtask may absolutely depend on it; it can never be '
    + 'satisfied by describing the result in words. Do NOT plan a subtask whose completion depends on creating a '
    + 'directory, scaffolding a project, saving a file, installing a package, or running a command — those cannot '
    + 'happen here, and a subtask that requires one fails however well the worker performs.',
};

/**
 * The spec shape to show a planner, given what this run can actually finish.
 *
 * `canWriteFiles` should come from the tool registry the workers will actually
 * get — the same question `canProduceFiles()` answers for the verification
 * ladder (see t3-worker.ts). Planning and grading disagreeing about it is the
 * whole failure this addresses, so they read the same signal.
 *
 * `canGenerateAssets` is a SECOND question, not a refinement of the first:
 * media tools register outside `enabledTools`, so a run can have no disk and
 * still produce a finished video. Neither argument has a default — inferring
 * one from the other is precisely the mistake being corrected here.
 */
export function planSpecShape(canWriteFiles: boolean, canGenerateAssets: boolean): PlanSpecShape {
  if (canWriteFiles) return WITH_FILES;
  return canGenerateAssets ? WITHOUT_FILES_WITH_GENERATORS : WITHOUT_FILES;
}

/** The `files` and `acceptance` rules as T1's plan prompt labels them. */
export function quotedFieldRules(spec: PlanSpecShape): string {
  return `- "files": ${spec.filesGuidance}\n- "acceptance": ${spec.acceptanceGuidance}`;
}

/** The same two rules as T2's field listing labels them. */
export function typedFieldRules(spec: PlanSpecShape): string {
  return `- files: string[] — ${spec.filesGuidance}\n- acceptance: string[] — ${spec.acceptanceGuidance}`;
}
