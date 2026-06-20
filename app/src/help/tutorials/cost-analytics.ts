import type { TourStep } from '../types.js';

export const VIDEO_ID = ''; // populate after HyperFrames render

export const steps: TourStep[] = [
  {
    target: '.status-bar',
    content: 'Session cost and total tokens update in real time here. Cost resets each session.',
    placement: 'top',
  },
  {
    target: '.status-bar',
    content: 'T1 / T2 / T3 model labels show the active model per tier. With Cascade Auto, each agent may use a different model — the cost reflects the aggregate.',
    placement: 'top',
  },
];

export const docs = `
# Cost & Analytics

## Session Cost

The status bar shows cumulative cost for the current session. This resets when
you start a new session. Cascade counts both input and output tokens for every
T1, T2, and T3 call.

## Budget Limits

Set \`maxCostUsd\` in your Cascade config to cap spending per session. When
the limit is hit, Cascade pauses and escalates to you for approval before continuing.

\`\`\`json
{
  "maxCostUsd": 2.00,
  "cascadeAuto": true
}
\`\`\`

## Cascade Auto Cost Impact

Cascade Auto often _reduces_ cost because it routes simple subtasks to cheaper
models (e.g. Haiku or GPT-4o Mini) rather than using a premium model for everything.
Complex coding or analysis subtasks still route to a capable model, but routine
text generation goes to the cheapest appropriate option.

## Token Breakdown

In the Cockpit Inspector panel (click any agent node), you can see the exact
prompt and completion token count for each individual agent call. This helps
identify which agents are consuming the most context.

## Tips for Cost Control

- Use **Cascade Auto** — it routes cheaper models to simple subtasks automatically.
- Set a **budget limit** for exploratory or experimental tasks.
- Use the **Code view** with Monaco to review agent-generated code before accepting it.
- Prefer specific, scoped task prompts — vague prompts lead to more rounds of iteration.
`;
