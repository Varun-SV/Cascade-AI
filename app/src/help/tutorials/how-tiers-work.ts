import type { Step } from 'react-joyride';

export const VIDEO_ID = ''; // populate after HyperFrames render

export const steps: Step[] = [
  {
    target: '.agent-graph',
    content: 'The Agent Graph shows your three-tier hierarchy in real time. T1 is the Administrator at the top, T2 are section Managers in the middle, T3 are Worker agents at the bottom.',
    placement: 'left',
    disableBeacon: true,
  },
  {
    target: '.agent-graph',
    content: 'Glowing purple nodes are actively generating. Green means complete, red means failed, orange means escalated to you for a decision.',
    placement: 'left',
  },
  {
    target: '.status-bar',
    content: 'T1 / T2 / T3 labels in the status bar show the current model for each tier. With Cascade Auto on, T2 and T3 can each use different models simultaneously.',
    placement: 'top',
  },
];

export const docs = `
# How Tiers Work

Cascade AI uses a three-tier agent architecture to decompose and execute complex tasks.

## The Three Tiers

### T1 — Administrator
The T1 Administrator receives your top-level goal and decomposes it into sections.
It supervises the overall task, aggregates results, and handles high-level decisions.

### T2 — Manager
Each T2 Manager is responsible for one section of the task. It further breaks
the section into concrete subtasks, dispatches them to T3 Workers, monitors
progress, and aggregates the results from its workers.

### T3 — Worker
T3 Workers are the "hands" — they execute individual subtasks (write code,
draft text, run analysis, call APIs) and return structured results to their T2 Manager.

## Cascade Auto Routing

When \`cascadeAuto: true\`, each T2 Manager independently selects the
benchmark-best model for its section type, and each T3 Worker independently selects
the best model for its subtask. This means:

- A coding section → routes to the model with the best code benchmark score
- A writing section → routes to the model with the best creative-writing score
- Two concurrent T3 workers can use two completely different models

## Escalation

If a T3 Worker encounters a decision requiring human input (e.g. overwriting a file,
incurring cost above a limit), it escalates to its T2 Manager, which escalates to T1,
which surfaces an orange notification to you. Approve or reject in the Cockpit view.
`;
