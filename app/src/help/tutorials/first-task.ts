import type { Step } from 'react-joyride';

export const VIDEO_ID = ''; // populate after HyperFrames render

export const steps: Step[] = [
  {
    target: '.task-input-bar',
    content: 'Type your goal here. Be specific — "Build a REST API with Express that manages a to-do list" works better than "Make an app".',
    placement: 'top',
    disableBeacon: true,
  },
  {
    target: '.task-input-bar',
    content: 'Hit ⌘Enter (or Ctrl+Enter on Windows/Linux) to submit. Cascade will decompose your task and spin up agents.',
    placement: 'top',
  },
  {
    target: '.agent-graph',
    content: 'Watch agent nodes appear as Cascade decomposes your task. The graph builds top-down: T1 first, then T2 Managers, then T3 Workers.',
    placement: 'left',
  },
  {
    target: '.agent-graph',
    content: 'Click any agent node to inspect its live output stream in the inspector panel on the right.',
    placement: 'left',
  },
  {
    target: '.status-bar',
    content: 'Monitor cost and token usage in real time at the bottom. You can set budget limits in Settings.',
    placement: 'top',
  },
];

export const docs = `
# Running Your First Task

## Quick Start

1. Switch to **Cockpit** view (the grid icon in the Activity Bar).
2. Type your goal in the task input at the top of the screen.
3. Press **⌘Enter** (macOS) or **Ctrl+Enter** (Windows/Linux) to submit.

## Writing Effective Task Prompts

| Works Well | Too Vague |
|-----------|-----------|
| "Refactor the auth module to use JWT, add refresh token rotation, write tests" | "Fix auth" |
| "Write a blog post about Cascade Auto routing, 600 words, technical audience" | "Write something" |
| "Analyse sales_q2.csv, find top 10 products by margin, output a markdown table" | "Analyse the data" |

## Watching the Graph

- **Purple glow** = agent is actively generating
- **Green** = agent completed successfully
- **Orange** = agent needs your approval (escalation)
- **Red** = agent failed (click to see error)

Click any node to open its Inspector — you'll see the live streaming output
and the full input/output record once it completes.

## Providing Approval

When an agent escalates a decision to you, an orange badge appears on the
Cockpit view icon. Switch to Cockpit, click the orange node, read the request,
and click **Approve** or **Reject**.
`;
