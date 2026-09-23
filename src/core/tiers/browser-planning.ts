// ─────────────────────────────────────────────
//  Cascade AI — Planning around a live browser
// ─────────────────────────────────────────────
//
//  The reported run had the Browser chip on and the Web chip off. The request
//  was "go to chatgpt.com using browser control, ask an extremely difficult
//  question, and give me its answer unchanged". The answer came back as
//  sections titled "Analysis 1: Quantum Gravity…", opening with "this
//  environment does not possess browser-automation tools". Yet every worker
//  in that run had `browser_control` registered.
//
//  No tier above the worker was told the browser existed. The classifier, T1
//  and T2 all read a prompt naming a website with no web tool in sight, so the
//  only plan left was to write what the site would have said. Each worker then
//  got a slice ("write Analysis 1") that never needed the browser.
//
//  describeGenerationForPlanner closes the same gap for media: a capability
//  whose plan SHAPE the planner cannot guess. The browser's shape is one
//  worker holding one session end to end, not parallel sections.

export const BROWSER_TOOL = 'browser_control';

/**
 * What the planners (T1 and T2) need to know about the browser. Empty when this
 * run has none, so a run without a browser gets exactly the prompt it had.
 */
export function describeBrowserForPlanner(has: (toolName: string) => boolean): string {
  if (!has(BROWSER_TOOL)) return '';
  return [
    `LIVE BROWSER — this run can drive a real web browser with the "${BROWSER_TOOL}" tool: open pages, click, type, and read what the page shows.`,
    '- A task that says to visit, open or use a website, or to get something from one, MUST be planned around that tool. Its deliverable is what the page actually showed.',
    '- Plan all of that as ONE subtask for ONE T3 worker, done end to end: navigate, interact, read the result back. '
      + 'The run has one browser session. Workers do not share a page, and a second worker asking for the browser while the first holds it is refused.',
    '- Never plan a step that writes what the site would have said. When the site\'s output is the deliverable, only the browser can produce it.',
  ].join('\n');
}

/** For the worker: the tool it has, and that the page — not the model — is the source. */
export const BROWSER_WORKER_RULE =
  `- Use the "${BROWSER_TOOL}" tool to open and interact with a website when your subtask involves one. `
  + 'Report what the page actually showed — word for word when the subtask asks for it unchanged.';

/**
 * For the complexity classifier. A one-site errand is one agent's job; routed
 * Complex it becomes a plan, and a plan is where the browser went missing.
 */
export const BROWSER_ROUTING_RULE =
  '- A live browser is available. Visiting a website to do something there and bringing back what it shows is "Simple" '
  + '(one agent drives the browser), unless the user also asks for substantial work beyond it.';
