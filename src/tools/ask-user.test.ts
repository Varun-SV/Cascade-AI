// ─────────────────────────────────────────────
//  Cascade AI — ask_user
// ─────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { AskUserTool, type ClarificationResult, type ClarificationQuestion } from './ask-user.js';

const opts = { tierId: 't3', sessionId: 'task-1', requireApproval: false };

/** Captures what the tool asked, and answers however the test wants. */
function asker(result: ClarificationResult) {
  const asked: ClarificationQuestion[][] = [];
  const fn = async (questions: ClarificationQuestion[]) => { asked.push(questions); return result; };
  return { asked, fn };
}

const answered = (answers: ClarificationResult['answers']): ClarificationResult =>
  ({ outcome: 'answered', answers });

describe('ask_user', () => {
  it('asks everything in one questionnaire rather than one question per call', async () => {
    // Ambiguity arrives in clusters — which account, which range, drafts or
    // not. Three calls is three round trips and reads as an interrogation.
    const a = asker(answered([
      { id: 'q1', value: 'The personal one' },
      { id: 'q2', value: ['Drafts', 'Archived'] },
    ]));
    const out = await new AskUserTool(a.fn).execute({
      questions: [
        { prompt: 'Which account?', kind: 'choice', options: ['The personal one', 'The work one'] },
        { prompt: 'Include which?', kind: 'multi', options: ['Drafts', 'Archived'] },
      ],
    }, opts);

    expect(a.asked, 'one call, both questions').toHaveLength(1);
    expect(a.asked[0]).toHaveLength(2);
    expect(out).toContain('Which account?');
    expect(out).toContain('The personal one');
    expect(out, 'several selections read back as a list').toContain('Drafts, Archived');
  });

  it('assigns the ids itself rather than trusting the model with them', async () => {
    // Two questions sharing an id loses an answer silently: the second
    // overwrites the first, and nothing anywhere says a question went
    // unanswered.
    const a = asker(answered([]));
    await new AskUserTool(a.fn).execute({
      questions: [
        { prompt: 'First?', kind: 'text', id: 'same' },
        { prompt: 'Second?', kind: 'text', id: 'same' },
      ],
    }, opts);

    expect(a.asked[0]?.map((q) => q.id), 'positional, and ours').toEqual(['q1', 'q2']);
  });

  it('turns a choice with nothing to choose between into a text question', async () => {
    // A `choice` with one option renders as a prompt with a single button, and
    // one with none renders as a prompt with no way to answer at all.
    const a = asker(answered([{ id: 'q1', value: 'whatever they typed' }]));
    await new AskUserTool(a.fn).execute({
      questions: [{ prompt: 'Which?', kind: 'choice', options: ['only one'] }],
    }, opts);

    expect(a.asked[0]?.[0]?.kind).toBe('text');
    expect(a.asked[0]?.[0]).not.toHaveProperty('options');
  });

  it('tells the model to proceed when there is nobody to ask', async () => {
    // The headless case — a scheduled run, an API caller with no socket. This
    // is the whole reason the tool can be offered at all: if a non-answer
    // parked the run, it could not be registered.
    const out = await new AskUserTool(async () => ({ outcome: 'no-listener', answers: [] }))
      .execute({ questions: [{ prompt: 'Which account?', kind: 'text' }] }, opts);

    expect(out).toMatch(/nobody watching/i);
    expect(out, 'and is told what to do instead').toMatch(/best reading/i);
  });

  it('distinguishes not answering from not being there, and from being stopped', async () => {
    // Different things to whoever reads the transcript afterwards: nobody was
    // asked, somebody was asked and did not reply, or the run ended underneath
    // the question.
    const timedOut = await new AskUserTool(async () => ({ outcome: 'timeout', answers: [] }))
      .execute({ questions: [{ prompt: 'Which?', kind: 'text' }] }, opts);
    const stopped = await new AskUserTool(async () => ({ outcome: 'aborted', answers: [] }))
      .execute({ questions: [{ prompt: 'Which?', kind: 'text' }] }, opts);

    expect(timedOut).toMatch(/did not answer in time/i);
    expect(stopped).toMatch(/stopped while the question was open/i);
  });

  it('says a question went unanswered rather than dropping its row', async () => {
    // Free text left blank, or a multi-select with nothing ticked, is ordinary.
    // Omitting the row would read as never having asked.
    const out = await new AskUserTool(asker(answered([{ id: 'q1', value: 'yes' }])).fn).execute({
      questions: [
        { prompt: 'Answered one?', kind: 'text' },
        { prompt: 'Skipped one?', kind: 'text' },
      ],
    }, opts);

    expect(out).toContain('Skipped one?');
    expect(out).toContain('(no answer given)');
  });

  it('refuses a call with no usable question instead of showing an empty form', async () => {
    const out = await new AskUserTool(asker(answered([])).fn)
      .execute({ questions: [{ prompt: '   ', kind: 'text' }] }, opts);
    expect(out).toMatch(/^Error:/);
  });

  it('needs no approval, because asking changes nothing', async () => {
    // A prompt asking permission to show a prompt is a tax on the behaviour we
    // are trying to encourage.
    expect(new AskUserTool(async () => ({ outcome: 'no-listener', answers: [] })).isDangerous()).toBe(false);
  });
});
