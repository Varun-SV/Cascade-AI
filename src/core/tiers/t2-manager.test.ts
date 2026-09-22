import { describe, expect, it, vi, afterEach } from 'vitest';
import { getMaxListeners } from 'node:events';
import type { GenerateResult, T1ToT2Assignment, ToolDefinition } from '../../types.js';
import type { CascadeRouter } from '../router/index.js';
import type { ToolRegistry } from '../../tools/registry.js';
import { T2Manager } from './t2-manager.js';
import { T3Worker } from './t3-worker.js';

function makeResult(content: string, finishReason: GenerateResult['finishReason'] = 'stop'): GenerateResult {
  return {
    content,
    finishReason,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      estimatedCostUsd: 0,
    },
  };
}

function makeAssignment(): T1ToT2Assignment {
  return {
    sectionId: 'section-1',
    sectionTitle: 'Build release notes',
    description: 'Generate release notes from the completed work',
    expectedOutput: 'A final release-notes summary',
    constraints: [],
    executionMode: 'parallel',
    t3Subtasks: [
      {
        subtaskId: 'draft',
        subtaskTitle: 'Draft notes',
        description: 'Draft the initial notes',
        expectedOutput: 'Drafted notes',
        constraints: [],
        peerT3Ids: [],
        dependsOn: [],
      },
      {
        subtaskId: 'finalize',
        subtaskTitle: 'Finalize notes',
        description: 'Finalize after the draft is complete',
        expectedOutput: 'Finalized notes',
        constraints: [],
        peerT3Ids: [],
        dependsOn: ['draft'],
      },
    ],
  };
}

function makeToolRegistry(): ToolRegistry {
  const definitions: ToolDefinition[] = [];
  return {
    getToolDefinitions: () => definitions,
    requiresApproval: () => false,
    isDangerous: () => false,
    hasTool: () => false,
    execute: vi.fn(),
  } as unknown as ToolRegistry;
}

describe('T2Manager', () => {
  it('executes dependent subtasks in dependency order and aggregates the result', async () => {
    const executionOrder: string[] = [];

    const router = {
      generate: vi.fn(async (tier, options) => {
        const latest = options.messages[options.messages.length - 1];
        const content = typeof latest?.content === 'string' ? latest.content : '';

        if (content.startsWith('Execute the following subtask completely:')) {
          const title = /\*\*(.+?)\*\*/.exec(content)?.[1] ?? 'unknown';
          executionOrder.push(title);
          return makeResult(`${title} complete`);
        }

        if (content.startsWith('Self-test this output')) {
          return makeResult('{"completeness":"pass","correctness":"pass","compliance":"pass","notes":"ok"}');
        }

        if (tier === 'T2') {
          return makeResult('Merged release notes');
        }

        return makeResult('ok');
      }),
      getModelForTier: () => undefined,
    } as unknown as CascadeRouter;

    const manager = new T2Manager(router, makeToolRegistry(), 't1-root');
    const result = await manager.execute(makeAssignment(), 'task-1');

    expect(result.status).toBe('COMPLETED');
    expect(result.sectionSummary).toBe('Merged release notes');
    expect(executionOrder).toEqual(['Draft notes', 'Finalize notes']);
  });

  it('breaks cyclic dependencies instead of deadlocking the section', async () => {
    const router = {
      generate: vi.fn(async (_tier, options) => {
        const latest = options.messages[options.messages.length - 1];
        const content = typeof latest?.content === 'string' ? latest.content : '';
        if (content.startsWith('Self-test this output')) {
          return makeResult('{"completeness":"pass","correctness":"pass","compliance":"pass","notes":"ok"}');
        }
        if (content.startsWith('Summarize these T3 worker outputs')) {
          return makeResult('Cyclic section merged');
        }
        return makeResult('completed');
      }),
      getModelForTier: () => undefined,
    } as unknown as CascadeRouter;

    const assignment = makeAssignment();
    assignment.t3Subtasks[0]!.dependsOn = ['finalize'];

    const manager = new T2Manager(router, makeToolRegistry(), 't1-root');
    const result = await manager.execute(assignment, 'task-2');

    expect(result.status).toBe('COMPLETED');
    expect(result.t3Results).toHaveLength(2);
    expect(result.t3Results.every((t3) => t3.status === 'COMPLETED')).toBe(true);
  });

  it('recovers when T2s own LLM decomposition omits `constraints` on a subtask (used to crash with "Cannot read properties of undefined (reading \'join\')")', async () => {
    const router = {
      generate: vi.fn(async (tier, options) => {
        const latest = options.messages[options.messages.length - 1];
        const content = typeof latest?.content === 'string' ? latest.content : '';
        if (content.startsWith('Decompose this section into')) {
          // Real LLM JSON that omits `constraints` entirely — the exact shape
          // that crashed T3Worker's prompt builders (`.join`/`.map` on
          // undefined) for every subtask at once.
          return makeResult(JSON.stringify([
            { subtaskId: 'only', subtaskTitle: 'Do it', description: 'd', expectedOutput: 'o', peerT3Ids: [], dependsOn: [] },
          ]));
        }
        if (content.startsWith('Execute the following subtask completely:')) {
          return makeResult('done');
        }
        if (content.startsWith('Self-test this output')) {
          return makeResult('{"completeness":"pass","correctness":"pass","compliance":"pass","notes":"ok"}');
        }
        if (tier === 'T2') return makeResult('merged');
        return makeResult('ok');
      }),
      getModelForTier: () => undefined,
    } as unknown as CascadeRouter;

    const assignment = makeAssignment();
    assignment.t3Subtasks = []; // forces T2's own LLM decomposition, not T1's

    const manager = new T2Manager(router, makeToolRegistry(), 'root');
    const result = await manager.execute(assignment, 'task-missing-constraints');

    expect(result.status).toBe('COMPLETED');
    expect(result.t3Results).toHaveLength(1);
    expect(result.t3Results[0]!.status).toBe('COMPLETED');
  });

  // ── Boardroom gate (Moderate / planApproval: 'all') ──

  it('gate reject stops the section before any worker runs', async () => {
    const router = {
      generate: vi.fn(async () => makeResult('should not run')),
      getModelForTier: () => undefined,
    } as unknown as CascadeRouter;

    const manager = new T2Manager(router, makeToolRegistry(), 'root');
    manager.setPlanApprovalCallback(async () => ({ approved: false }));
    const result = await manager.execute(makeAssignment(), 'task-reject');

    expect(result.t3Results).toHaveLength(0);
    expect(result.sectionSummary).toContain('rejected');
    expect(router.generate).not.toHaveBeenCalled();
  });

  it('gate keepSubtaskIds drops the other subtasks before dispatch', async () => {
    const executed: string[] = [];
    const router = {
      generate: vi.fn(async (tier, options) => {
        const latest = options.messages[options.messages.length - 1];
        const content = typeof latest?.content === 'string' ? latest.content : '';
        if (content.startsWith('Execute the following subtask completely:')) {
          executed.push(/\*\*(.+?)\*\*/.exec(content)?.[1] ?? 'unknown');
          return makeResult('done');
        }
        if (content.startsWith('Self-test this output')) {
          return makeResult('{"completeness":"pass","correctness":"pass","compliance":"pass","notes":"ok"}');
        }
        if (tier === 'T2') return makeResult('merged');
        return makeResult('ok');
      }),
      getModelForTier: () => undefined,
    } as unknown as CascadeRouter;

    const manager = new T2Manager(router, makeToolRegistry(), 'root');
    manager.setPlanApprovalCallback(async () => ({ approved: true, keepSubtaskIds: ['draft'] }));
    await manager.execute(makeAssignment(), 'task-keep');

    expect(executed).toEqual(['Draft notes']); // 'Finalize notes' was dropped
  });

  // ── T3→T2 reinforcement request ──

  it('spawns reinforcement sibling workers when a T3 calls request_workers', async () => {
    const executed: string[] = [];
    const router = {
      generate: vi.fn(async (_tier, options) => {
        const msgs = options.messages as Array<{ role: string; content: unknown }>;
        const last = msgs[msgs.length - 1];
        const content = typeof last?.content === 'string' ? last.content : '';
        if (content.startsWith('Self-test this output')) {
          return makeResult('{"completeness":"pass","correctness":"pass","compliance":"pass","notes":"ok"}');
        }
        if (content.startsWith('Summarize')) return makeResult('merged');
        // Once the request_workers tool result is in the conversation, finish.
        if (msgs.some((m) => m.role === 'tool')) return makeResult('done');
        if (content.startsWith('Execute the following subtask completely:')) {
          const title = /\*\*(.+?)\*\*/.exec(content)?.[1] ?? '?';
          executed.push(title);
          if (content.includes('FANOUT')) {
            return {
              content: 'requesting help',
              finishReason: 'tool_use' as const,
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 },
              toolCalls: [{ id: 'tc1', name: 'request_workers', input: { subtasks: [
                { title: 'Helper A', description: 'do A' },
                { title: 'Helper B', description: 'do B' },
              ] } }],
            };
          }
          return makeResult(`${title} done`);
        }
        return makeResult('ok');
      }),
      getModelForTier: () => undefined,
      getReinforcementsConfig: () => ({ enabled: true, maxPerSection: 4 }),
    } as unknown as CascadeRouter;

    const assignment: T1ToT2Assignment = {
      sectionId: 'sec', sectionTitle: 'Section', description: 'd', expectedOutput: 'o', constraints: [],
      executionMode: 'parallel',
      t3Subtasks: [{ subtaskId: 'main', subtaskTitle: 'Main', description: 'FANOUT this big task', expectedOutput: 'o', constraints: [], peerT3Ids: [], dependsOn: [] }],
    };

    const manager = new T2Manager(router, makeToolRegistry(), 't1-root');
    await manager.execute(assignment, 'task-reinf');

    // The worker requested two helpers; T2 spawned and ran both as siblings.
    expect(executed).toContain('Main');
    expect(executed).toContain('Helper A');
    expect(executed).toContain('Helper B');
  });

  // ── Permission evaluation (dangerous tools advise, never final-approve) ──

  it('auto-approves a non-dangerous tool at T2 without escalating', async () => {
    const router = {
      generate: vi.fn(async () => makeResult('YES')),
      getModelForTier: () => undefined,
    } as unknown as CascadeRouter;
    const manager = new T2Manager(router, makeToolRegistry(), 'root');

    const req = {
      id: 'p1', requestedBy: 't3-a', parentT2Id: (manager as any).id,
      toolName: 'diff_view', input: {}, isDangerous: false,
      subtaskContext: 's', sectionContext: 'sec',
    };
    const decision = await (manager as any).evaluatePermissionAtT2(req);

    expect(decision).not.toBeNull();
    expect(decision.approved).toBe(true);
    expect(decision.decidedBy).toBe('T2');
    expect(router.generate).not.toHaveBeenCalled(); // no LLM call for safe path
  });

  it('never final-approves a DANGEROUS tool — records advice on the trail and returns null so it reaches the user', async () => {
    const router = {
      generate: vi.fn(async () => makeResult('YES')), // even a confident YES must not auto-approve
      getModelForTier: () => undefined,
    } as unknown as CascadeRouter;
    const manager = new T2Manager(router, makeToolRegistry(), 'root');

    const req: any = {
      id: 'p2', requestedBy: 't3-a', parentT2Id: (manager as any).id,
      toolName: 'shell_run', input: { command: 'rm -rf build' }, isDangerous: true,
      subtaskContext: 's', sectionContext: 'sec',
    };
    const decision = await (manager as any).evaluatePermissionAtT2(req);

    expect(decision).toBeNull(); // escalates past T2
    expect(router.generate).toHaveBeenCalledOnce();
    expect(req.trail).toHaveLength(1);
    expect(req.trail[0]).toMatchObject({ tier: 'T2', verdict: 'approve' });
  });

  // ── retryT3 wiring parity (bug fix) ──

  describe('retryT3', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('wires the permission escalator onto a retried T3 worker (not just the first attempt)', async () => {
      const setEscalatorSpy = vi.spyOn(T3Worker.prototype, 'setPermissionEscalator');
      let attempt = 0;
      vi.spyOn(T3Worker.prototype, 'execute').mockImplementation(async function (this: T3Worker) {
        attempt++;
        if (attempt === 1) throw new Error('transient worker failure');
        return {
          subtaskId: 'draft', status: 'COMPLETED', output: 'ok',
          testResults: { checksRun: [], passed: [] }, issues: [],
        } as any;
      });

      const router = {
        generate: vi.fn(async () => makeResult('Merged release notes')),
        getModelForTier: () => undefined,
      } as unknown as CascadeRouter;

      const manager = new T2Manager(router, makeToolRegistry(), 'root');
      const escalator = { requestPermission: vi.fn(), setT2Evaluator: vi.fn() } as any;
      manager.setPermissionEscalator(escalator);

      const assignment = makeAssignment();
      assignment.t3Subtasks = [assignment.t3Subtasks[0]!]; // single independent subtask → one retry

      await manager.execute(assignment, 'task-retry');

      expect(attempt).toBeGreaterThanOrEqual(2); // the retry actually ran
      // Every T3Worker constructed — the first attempt AND the retry — got the
      // escalator wired. Before the fix, retryT3() built a bare worker with no
      // setPermissionEscalator call at all.
      for (const call of setEscalatorSpy.mock.calls) {
        expect(call[0]).toBe(escalator);
      }
      expect(setEscalatorSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('escalation — user chooses "skip"', () => {
    it('marks the returned T2Result userSkipped, so T1 review does not re-correct it', async () => {
      // The self-test always fails, on both the initial pass and the retest
      // after correctOutput() — that is what makes the worker ESCALATE rather
      // than complete, the common one-worker-section shape this feature is
      // meant to cover.
      const router = {
        generate: vi.fn(async (_tier, options) => {
          const latest = options.messages[options.messages.length - 1];
          const content = typeof latest?.content === 'string' ? latest.content : '';
          if (content.startsWith('Self-test this output')) {
            return makeResult('{"completeness":"fail","correctness":"fail","compliance":"fail","notes":"needs more"}');
          }
          return makeResult('draft output');
        }),
        getModelForTier: () => undefined,
      } as unknown as CascadeRouter;

      const assignment = makeAssignment();
      assignment.t3Subtasks = [assignment.t3Subtasks[0]!];
      assignment.t3Subtasks[0]!.dependsOn = [];

      const manager = new T2Manager(router, makeToolRegistry(), 't1-root');
      manager.setEscalationCallback(async () => ({ action: 'skip' }));

      const result = await manager.execute(assignment, 'task-skip');

      expect(result.status).toBe('PARTIAL'); // kept, not dropped — see settledEscalationStatus
      expect(result.userSkipped).toBe(true);
    });

    it('tells the asker what the section was FOR, not just what went wrong', async () => {
      // The prompt this reaches opened with a section title and the failure.
      // "Main Task" names the work no better than its id does, so the person
      // was choosing between retry, re-guide and skip with only the failure in
      // front of them — and the goal is the one field that says what a retry
      // would be retrying.
      const router = {
        generate: vi.fn(async (_tier, options) => {
          const latest = options.messages[options.messages.length - 1];
          const content = typeof latest?.content === 'string' ? latest.content : '';
          if (content.startsWith('Self-test this output')) {
            return makeResult('{"completeness":"fail","correctness":"fail","compliance":"fail","notes":"needs more"}');
          }
          return makeResult('draft output');
        }),
        getModelForTier: () => undefined,
      } as unknown as CascadeRouter;

      const assignment = makeAssignment();
      assignment.t3Subtasks = [assignment.t3Subtasks[0]!];
      assignment.t3Subtasks[0]!.dependsOn = [];
      assignment.description = 'Log in and probe the chatbot for prompt leakage';

      const manager = new T2Manager(router, makeToolRegistry(), 't1-root');
      let asked: { goal?: string; summary?: string } | undefined;
      manager.setEscalationCallback(async (ctx) => { asked = ctx; return { action: 'skip' }; });

      const result = await manager.execute(assignment, 'task-goal');

      expect(asked?.goal, 'what the section was asked to do').toBe('Log in and probe the chatbot for prompt leakage');
      // NOT merely present. The first version of this asserted `toBeTruthy()`
      // and passed while the prompt displayed the default aggregation — which
      // drops ESCALATED workers, so a one-worker section read "no T3 workers
      // completed". That string is truthy. The person was told there was no
      // work, and Skip then kept work they had never been shown.
      expect(asked?.summary, 'the escalated work is what the person is shown').not.toMatch(/no T3 workers completed/);
      expect(result.sectionSummary, 'and Skip keeps exactly what was shown').toBe(asked?.summary);
    });

    // On a presenter T2 (a Moderate root run) every aggregation streams itself
    // as the primary answer, and clients keep what streamed: they append
    // tokens and fill a bubble from the returned output only when nothing
    // streamed. So what streams has to be the answer the run returns — never a
    // draft a retry replaces, and never a summary when the run's answer is not
    // built on one (with no worker COMPLETED, `cascade.ts` returns the worker's
    // partial output and the reason instead — see summaryLeadsRootAnswer).
    describe('streaming a pending section', () => {
      // One worker, which escalates every time.
      const escalatingRouter = () => ({
        generate: vi.fn(async (_tier: unknown, options: { messages: Array<{ content: unknown }> }, onChunk?: (c: { text: string }) => void) => {
          const latest = options.messages[options.messages.length - 1];
          const content = typeof latest?.content === 'string' ? latest.content : '';
          if (content.startsWith('Self-test this output')) {
            return makeResult('{"completeness":"fail","correctness":"fail","compliance":"fail","notes":"needs more"}');
          }
          // Aggregations are marked so they can be told apart from worker output.
          const text = content.startsWith('Summarize these T3 worker outputs') ? 'SECTION-SUMMARY' : 'draft output';
          onChunk?.({ text });
          return makeResult(text);
        }),
        getModelForTier: () => undefined,
      }) as unknown as CascadeRouter;

      // Two workers: the draft passes its self-test, the finalize escalates.
      // The one-worker shape cannot see a streamed draft through the FIRST
      // aggregation: with nothing COMPLETED it returns early without a model
      // call. Here it summarises finished work and really streams.
      const mixedRouter = () => ({
        generate: vi.fn(async (
          _tier: unknown,
          options: { messages: Array<{ content: unknown }>; systemPrompt?: string },
          onChunk?: (c: { text: string }) => void,
        ) => {
          const all = [options.systemPrompt ?? '', ...options.messages.map((m) => (typeof m.content === 'string' ? m.content : ''))].join('\n');
          const latest = options.messages[options.messages.length - 1];
          const content = typeof latest?.content === 'string' ? latest.content : '';
          if (content.startsWith('Self-test this output')) {
            return makeResult(content.includes('OUTPUT-FINALIZE')
              ? '{"completeness":"fail","correctness":"fail","compliance":"fail","notes":"needs more"}'
              : '{"completeness":"pass","correctness":"pass","compliance":"pass","notes":"ok"}');
          }
          if (content.startsWith('Summarize these T3 worker outputs')) {
            onChunk?.({ text: 'SECTION-SUMMARY' });
            return makeResult('SECTION-SUMMARY');
          }
          const text = all.includes('Finalize after the draft') ? 'OUTPUT-FINALIZE' : 'OUTPUT-DRAFT';
          onChunk?.({ text });
          return makeResult(text);
        }),
        getModelForTier: () => undefined,
      }) as unknown as CascadeRouter;

      const presenting = async (shape: 'one worker' | 'mixed', decide: 'retry' | 'skip' | 'timeout') => {
        const assignment = makeAssignment();
        if (shape === 'one worker') {
          assignment.t3Subtasks = [assignment.t3Subtasks[0]!];
          assignment.t3Subtasks[0]!.dependsOn = [];
        }
        const manager = new T2Manager(shape === 'mixed' ? mixedRouter() : escalatingRouter(), makeToolRegistry(), 't1-root');
        manager.setPresenter(true);
        // EVERY primary token, not only the marked summary: the text this
        // guards against on a timeout is the "no T3 workers completed"
        // placeholder, which is not SECTION-SUMMARY.
        const answer: string[] = [];
        manager.on('stream:token', (e: { text: string; primary?: boolean }) => {
          if (e.primary) answer.push(e.text);
        });
        manager.setEscalationCallback(async () => ({ action: decide }));
        const result = await manager.execute(assignment, `task-${shape}-${decide}`);
        return { result, answer };
      };

      describe('a section where a worker finished — the summary leads the answer', () => {
        it('streams one answer on a retry, not a draft per attempt', async () => {
          const { result, answer } = await presenting('mixed', 'retry');
          expect(answer, 'the retry\u2019s answer, and nothing before it').toEqual(['SECTION-SUMMARY']);
          expect(result.sectionSummary).toBe('SECTION-SUMMARY');
        });

        it('streams the kept summary on a skip, once, at the moment it becomes final', async () => {
          // The draft is silent until the person answers — so Skip must say
          // it, or the one choice that KEEPS the work would stream nothing.
          const { result, answer } = await presenting('mixed', 'skip');
          expect(answer, 'exactly the kept summary').toEqual(['SECTION-SUMMARY']);
          expect(result.sectionSummary).toBe('SECTION-SUMMARY');
        });

        it('streams the finished work\u2019s summary when nobody answers', async () => {
          const { result, answer } = await presenting('mixed', 'timeout');
          expect(answer, 'the silent first aggregation, said once').toEqual(['SECTION-SUMMARY']);
          expect(result.status).toBe('FAILED');
        });
      });

      describe('a section where nothing finished — the worker\u2019s own work is the answer', () => {
        // Streaming a summary here put a text in the transcript that the run
        // never returned, and — because a non-empty stream is not replaced —
        // kept it there in place of the work and the reason it stopped.
        it('streams no placeholder when nobody answers', async () => {
          const { result, answer } = await presenting('one worker', 'timeout');
          expect(answer, 'nothing streamed, so the returned work and reason fill the answer').toEqual([]);
          expect(result.issues).toContain('Escalated, but no decision was received in time.');
        });

        it('streams no summary on a skip', async () => {
          const { result, answer } = await presenting('one worker', 'skip');
          expect(answer).toEqual([]);
          expect(result.status, 'the work is still kept').toBe('PARTIAL');
        });

        it('streams neither the draft nor a summary on a retry that escalates again', async () => {
          const { result, answer } = await presenting('one worker', 'retry');
          expect(answer).toEqual([]);
          expect(result.issues).toContain('Escalated again after the retry — no further attempts were made.');
        });
      });
    });

    it('does NOT set userSkipped when the skip was automatic — nobody actually reviewed it', async () => {
      // Same escalating section as above, but the callback returns the shape
      // Cascade's own SDK produces when nobody is listening (autonomy: 'auto',
      // no listener, an aborted run) — see EscalationDecision.automatic. T1's
      // reviewer must still be free to correct this section since no human
      // ever saw it.
      const router = {
        generate: vi.fn(async (_tier, options) => {
          const latest = options.messages[options.messages.length - 1];
          const content = typeof latest?.content === 'string' ? latest.content : '';
          if (content.startsWith('Self-test this output')) {
            return makeResult('{"completeness":"fail","correctness":"fail","compliance":"fail","notes":"needs more"}');
          }
          return makeResult('draft output');
        }),
        getModelForTier: () => undefined,
      } as unknown as CascadeRouter;

      const assignment = makeAssignment();
      assignment.t3Subtasks = [assignment.t3Subtasks[0]!];
      assignment.t3Subtasks[0]!.dependsOn = [];

      const manager = new T2Manager(router, makeToolRegistry(), 't1-root');
      manager.setEscalationCallback(async () => ({ action: 'skip', automatic: true }));

      const result = await manager.execute(assignment, 'task-auto-skip');

      expect(result.status).toBe('PARTIAL'); // work is still kept
      expect(result.userSkipped).toBeUndefined(); // but not attributed to a human decision
    });

    it('does NOT set userSkipped for an ordinary completed section', async () => {
      const router = {
        generate: vi.fn(async (_tier, options) => {
          const latest = options.messages[options.messages.length - 1];
          const content = typeof latest?.content === 'string' ? latest.content : '';
          if (content.startsWith('Self-test this output')) {
            return makeResult('{"completeness":"pass","correctness":"pass","compliance":"pass","notes":"ok"}');
          }
          return makeResult('Merged release notes');
        }),
        getModelForTier: () => undefined,
      } as unknown as CascadeRouter;

      const manager = new T2Manager(router, makeToolRegistry(), 't1-root');
      const result = await manager.execute(makeAssignment(), 'task-ok');

      expect(result.status).toBe('COMPLETED');
      expect(result.userSkipped).toBeUndefined();
    });
  });
});

describe('T2 decomposition prompt — media generation capability awareness', () => {
  // T2 is a planner too: it is the tier that turns "make a video" into the
  // actual subtask list. Without the same capability awareness T1 now gets, a
  // terminating generate_video step handed down by T1 gets decomposed straight
  // back into script-and-direction prose one level lower — the reported bug,
  // one tier down.
  function makeCapturingManager(captured: { systemPrompt?: string }, tools: string[]) {
    const router = {
      generate: vi.fn(async (_tier: string, options: { systemPrompt?: string }) => {
        captured.systemPrompt = options.systemPrompt;
        return makeResult('[]');
      }),
      getModelForTier: () => undefined,
    } as unknown as CascadeRouter;
    const toolRegistry = {
      getToolDefinitions: () => [],
      requiresApproval: () => false,
      isDangerous: () => false,
      hasTool: (n: string) => tools.includes(n),
      execute: vi.fn(),
    } as unknown as ToolRegistry;
    return new T2Manager(router, toolRegistry, 't1-root');
  }

  type Decompose = (a: T1ToT2Assignment) => Promise<unknown>;

  it('carries the video plan-shape rule into the subtask decomposition prompt', async () => {
    const captured: { systemPrompt?: string } = {};
    const manager = makeCapturingManager(captured, ['generate_video', 'generate_image', 'peer_message']);

    await (manager as unknown as { decomposeSection: Decompose }).decomposeSection(makeAssignment());

    expect(captured.systemPrompt).toContain('MEDIA GENERATION');
    expect(captured.systemPrompt).toContain('VIDEO PLANS MUST END IN THE TOOL CALL');
    // The predicate replaced a single hasPeerMessage boolean — the peer line
    // must still key off the real tool, not off the new argument shape.
    expect(captured.systemPrompt).toContain('peerT3Ids');
  });

  it('leaves the decomposition prompt untouched when no generation tool exists', async () => {
    const captured: { systemPrompt?: string } = {};
    const manager = makeCapturingManager(captured, []);

    await (manager as unknown as { decomposeSection: Decompose }).decomposeSection(makeAssignment());

    expect(captured.systemPrompt).not.toContain('MEDIA GENERATION');
    expect(captured.systemPrompt).not.toContain('peerT3Ids');
  });
});

describe('T2 wave signal — listener headroom', () => {
  it('gives the shared wave signal room for one listener per call', async () => {
    // Every worker in a wave shares this signal, and every provider call
    // beneath them attaches its own 'abort' listener to it. At Node's default
    // ceiling of ten, a wave wider than that logged a
    // MaxListenersExceededWarning on a perfectly ordinary run.
    const seen = new Set<AbortSignal>();
    const warnings: string[] = [];

    const router = {
      generate: vi.fn(async (_tier: string, options: { signal?: AbortSignal; messages: unknown[] }) => {
        if (options.signal) {
          seen.add(options.signal);
          // Stand in for what withTimeoutAbort does on every billable call.
          options.signal.addEventListener('abort', () => {}, { once: true });
        }
        const latest = options.messages[options.messages.length - 1] as { content?: unknown };
        const content = typeof latest?.content === 'string' ? latest.content : '';
        if (content.startsWith('Self-test this output')) {
          return makeResult('{"completeness":"pass","correctness":"pass","compliance":"pass","notes":"ok"}');
        }
        return makeResult('done');
      }),
      getModelForTier: () => undefined,
    } as unknown as CascadeRouter;

    // A wave comfortably wider than the default ceiling, with no dependencies
    // so all of them run at once.
    const assignment = makeAssignment();
    assignment.t3Subtasks = Array.from({ length: 16 }, (_, i) => ({
      subtaskId: `sub-${i}`,
      subtaskTitle: `Subtask ${i}`,
      description: 'Do the thing',
      expectedOutput: 'Output',
      constraints: [],
      peerT3Ids: [],
      dependsOn: [],
    }));

    const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation((w: string | Error) => {
      warnings.push(w instanceof Error ? `${w.name}: ${w.message}` : String(w));
    });
    try {
      const manager = new T2Manager(router, makeToolRegistry(), 't1-root');
      await manager.execute(assignment, 'task-wave');
    } finally {
      emitWarning.mockRestore();
    }

    // Nothing in a wide wave should look like a leak — not the shared signal,
    // and not the peer bus every worker in the section subscribes to.
    expect(warnings.filter((w) => w.startsWith('MaxListenersExceededWarning'))).toEqual([]);
    expect(seen.size).toBeGreaterThan(0);
    for (const signal of seen) expect(getMaxListeners(signal)).toBeGreaterThan(10);
  });
});

describe('T2 decomposition prompt — file capability awareness', () => {
  // T2 is the tier that writes the `files` and `acceptance` a worker is
  // actually held to, so a file-shaped criterion here fails the subtask on its
  // own — regardless of what T1 planned. Its field listing hard-coded
  // "(1-3 mechanically checkable done-criteria: file exists / contains X /
  // command exits 0)" for every run.
  function makeManager(captured: { prompt?: string }, toolNames: string[]) {
    const router = {
      generate: vi.fn(async (_tier: string, options: { messages: Array<{ content: unknown }> }) => {
        const latest = options.messages[options.messages.length - 1];
        const text = typeof latest?.content === 'string' ? latest.content : '';
        if (text.startsWith('Decompose this section')) captured.prompt = text;
        return makeResult('[]');
      }),
      getModelForTier: () => undefined,
    } as unknown as CascadeRouter;
    const toolRegistry = {
      getToolDefinitions: () => toolNames.map((name) => ({ name, description: '', inputSchema: {} })),
      requiresApproval: () => false,
      isDangerous: () => false,
      hasTool: (name: string) => toolNames.includes(name),
      execute: vi.fn(),
    } as unknown as ToolRegistry;
    return new T2Manager(router, toolRegistry, 't1-root');
  }

  type Decompose = (assignment: T1ToT2Assignment) => Promise<unknown>;

  const section: T1ToT2Assignment = {
    sectionId: 's1',
    sectionTitle: 'Data Preprocessing',
    description: 'Prepare the raw data',
    expectedOutput: 'Cleaned data',
    constraints: [],
    t3Subtasks: [],
  } as unknown as T1ToT2Assignment;

  it('preserves the generation deliverable when the run has a media tool', async () => {
    // Same split as T1's: no disk, but the run can still finish a real asset.
    // T2 writes the acceptance a worker is held to, so a preamble telling it
    // that text is the only possible output is the tier that actually costs
    // the user the video.
    const captured: { prompt?: string } = {};
    const manager = makeManager(captured, ['web_search', 'generate_image']);

    await (manager as unknown as { decomposeSection: Decompose }).decomposeSection(section);

    expect(captured.prompt).toMatch(/NO file, shell, or code-execution tools/i);
    expect(captured.prompt).not.toMatch(/written answer IS the deliverable/i);
    expect(captured.prompt).toMatch(/that call IS the deliverable/i);
  });

  it('asks for answer-shaped criteria when nothing can write a file', async () => {
    const captured: { prompt?: string } = {};
    const manager = makeManager(captured, ['web_search', 'web_fetch']);

    await (manager as unknown as { decomposeSection: Decompose }).decomposeSection(section);

    expect(captured.prompt).toMatch(/READING THE WRITTEN ANSWER/);
    expect(captured.prompt).toMatch(/leave EMPTY/i);
    expect(captured.prompt).not.toMatch(/file exists \/ contains X \/ command exits 0/);
  });

  it('keeps the mechanical criteria when the run can write files', async () => {
    const captured: { prompt?: string } = {};
    const manager = makeManager(captured, ['file_write']);

    await (manager as unknown as { decomposeSection: Decompose }).decomposeSection(section);

    expect(captured.prompt).toMatch(/file exists \/ contains X \/ command exits 0/);
    expect(captured.prompt).not.toMatch(/READING THE WRITTEN ANSWER/);
  });
});
