# Agent Orchestration

Cascade is not simply a round-robin model wrapper: it assigns work based on task complexity and coordinates agents through a hierarchy.

## Tiers

| Tier | Role | Typical behavior |
| --- | --- | --- |
| **T1 Administrator** | Plan and synthesize | Break complex work into sections, arrange managers, review and compile |
| **T2 Manager** | Coordinate a section | Decompose work, schedule T3 subtasks, aggregate and verify results |
| **T3 Worker** | Execute | Use tools, write outputs, self-check and escalate when needed |

Simple work can be handled directly or by a T3 worker; moderate work uses a T2 and its workers; complex work uses the complete hierarchy. This prevents paying for full coordination on a trivial question.

## Plans and dependencies

T1 section planning and T2 worker scheduling rely on a shared typed task graph and `DependencyScheduler`. Prerequisite ordering is enforced; a task blocked by a failed prerequisite should not be executed as though that prerequisite succeeded. Partial results are distinct from hard failures. Workers may request bounded additional help from their manager.

A plan approval setting can pause complex runs for human review before managers begin. The CLI also provides `/plan` to preview without executing and `/steer` for active work.

## Verification and safety

Cascade checks mechanical acceptance criteria (for example, file existence or exact contents) deterministically when possible. Other criteria may require model assessment. Tools have permission boundaries and can escalate through T3 → T2 → T1 → user. A plan is not itself permission to bypass tool approval.

## Continue instead of restart

Scheduler checkpoints support continuation after interruption, cancellation and budget limits. The CLI exposes `/continue` for the last resumable task. It retains confirmed completed work and re-plans remaining work where needed. Successful completion, partial completion, blocked work and failure are different outcomes.

## Inspect execution

- `/tree` — agent hierarchy.
- `/comms` — peer communication.
- `/why` — routing/complexity rationale.
- `/cost` — usage and estimated delegation savings.
- `/plan`, `/replan` and `/steer` — review and redirect work.

Sources: [tier implementations](https://github.com/Varun-SV/Cascade-AI/tree/main/src/core/tiers), [graph scheduler](https://github.com/Varun-SV/Cascade-AI/tree/main/src/core/orchestration), [core facade](https://github.com/Varun-SV/Cascade-AI/blob/main/src/core/cascade.ts).
