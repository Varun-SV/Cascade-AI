// ─────────────────────────────────────────────
//  Cascade AI — asking instead of assuming
// ─────────────────────────────────────────────
//
//  A model that cannot ask has exactly one move when a request is ambiguous:
//  guess, and present the guess as though it were the request. This gives it
//  the other move.
//
//  Deliberately a QUESTIONNAIRE rather than one question at a time. Ambiguity
//  arrives in clusters — which account, which date range, include drafts or not
//  — and asking those one per turn costs three round trips and reads as an
//  interrogation. Asked together they read as a form, which is a thing people
//  know how to finish.
//
//  The hard constraint is that this must never be able to park a run forever.
//  Nobody may be listening (a scheduled run, an API caller with no socket), the
//  person may close the tab, or they may simply not answer. Every one of those
//  resolves to "nobody answered" and the model is told to proceed on its own
//  best reading — because a run that hangs on an unanswerable question is worse
//  than one that made an assumption and said so.

import { BaseTool } from './base.js';
import type { ToolExecuteOptions } from '../types.js';

/** One thing the model needs to know before it can act. */
export interface ClarificationQuestion {
  /** Assigned here, never by the model: two questions with one id lose an answer. */
  id: string;
  prompt: string;
  /** `choice` picks one, `multi` picks any, `text` is free-form. */
  kind: 'choice' | 'multi' | 'text';
  /** Required for `choice` and `multi`; meaningless for `text`. */
  options?: string[];
}

export interface ClarificationAnswer {
  id: string;
  /** One option, several, or typed text — matching the question's `kind`. */
  value: string | string[];
}

/**
 * Why a questionnaire came back empty.
 *
 * Distinguished because they mean different things to a reader of the
 * transcript: nobody was there to ask, the person was asked and did not
 * answer, or the run ended underneath the question.
 */
export type ClarificationOutcome = 'answered' | 'no-listener' | 'timeout' | 'aborted';

export interface ClarificationResult {
  outcome: ClarificationOutcome;
  answers: ClarificationAnswer[];
}

/** What the host does with a questionnaire. Supplied by `Cascade`. */
export type ClarificationAsker = (
  questions: ClarificationQuestion[],
  signal: AbortSignal | undefined,
) => Promise<ClarificationResult>;

/** Bounded so one call cannot render an unanswerable wall of questions. */
export const MAX_QUESTIONS = 5;
/** Bounded so a question cannot render an unusable list. */
export const MAX_OPTIONS = 6;

export class AskUserTool extends BaseTool {
  readonly name = 'ask_user';

  readonly description =
    'Ask the person a short questionnaire when their request is genuinely ambiguous, instead of guessing. '
    + 'Use it when two readings of the request would produce materially different work — which account, which date range, '
    + 'whether to include drafts — and NOT for anything you can settle yourself or from the conversation. '
    + 'Ask everything you need in ONE call: several questions together read as a form, the same questions one per turn read as an interrogation. '
    + 'You may get no answer (nobody is watching, or they did not reply); if so, proceed on your best reading and say which assumption you made.';

  readonly inputSchema = {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_QUESTIONS,
        description: `The questions to ask together (at most ${MAX_QUESTIONS}).`,
        items: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'The question, as you would say it to them.' },
            kind: {
              type: 'string',
              enum: ['choice', 'multi', 'text'],
              description: 'choice = pick one, multi = pick any that apply, text = free-form answer.',
            },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: `The answers to offer, for choice and multi (at most ${MAX_OPTIONS}). Omit for text.`,
            },
          },
          required: ['prompt', 'kind'],
        },
      },
    },
    required: ['questions'],
  };

  private ask: ClarificationAsker;

  constructor(ask: ClarificationAsker) {
    super();
    this.ask = ask;
  }

  // Asking a question changes nothing, so it needs no approval gate: a prompt
  // asking permission to show a prompt is a tax on the behaviour we want.
  isDangerous(): boolean { return false; }

  async execute(input: Record<string, unknown>, options: ToolExecuteOptions): Promise<string> {
    const raw = Array.isArray(input['questions']) ? input['questions'] : [];
    const questions: ClarificationQuestion[] = [];

    for (const [i, q] of raw.slice(0, MAX_QUESTIONS).entries()) {
      const item = (q ?? {}) as Record<string, unknown>;
      const prompt = typeof item['prompt'] === 'string' ? item['prompt'].trim() : '';
      if (!prompt) continue;
      const kind = item['kind'] === 'multi' || item['kind'] === 'text' ? item['kind'] : 'choice';
      const options_ = Array.isArray(item['options'])
        ? item['options'].filter((o): o is string => typeof o === 'string' && o.trim() !== '').slice(0, MAX_OPTIONS)
        : [];
      // A choice with nothing to choose between is a text question wearing the
      // wrong label — and rendering it would produce a prompt with no answers.
      const resolved = kind !== 'text' && options_.length < 2 ? 'text' : kind;
      questions.push({
        // Positional, and assigned HERE. Letting the model supply ids invites
        // two questions sharing one, and the second answer would overwrite the
        // first with nothing to say it had.
        id: `q${i + 1}`,
        prompt,
        kind: resolved,
        ...(resolved === 'text' ? {} : { options: options_ }),
      });
    }

    if (questions.length === 0) {
      return 'Error: ask_user needs at least one question with a prompt.';
    }

    const result = await this.ask(questions, options.signal);

    if (result.outcome !== 'answered' || result.answers.length === 0) {
      // Named rather than generic, because the three cases mean different
      // things to whoever reads the transcript afterwards.
      const why = result.outcome === 'no-listener'
        ? 'There is nobody watching this run to answer'
        : result.outcome === 'aborted'
          ? 'The run was stopped while the question was open'
          : 'They did not answer in time';
      return `${why}. Proceed on your best reading of the request, and say plainly which assumption you made.`;
    }

    const byId = new Map(result.answers.map((a) => [a.id, a.value]));
    const lines = questions.map((q) => {
      const value = byId.get(q.id);
      const said = Array.isArray(value) ? value.join(', ') : value;
      // An unanswered question inside an answered questionnaire is ordinary:
      // free-text left blank, or a multi-select with nothing ticked. Saying so
      // beats omitting the row, which would read as never having asked.
      return `${q.prompt}\n  → ${said && said.length > 0 ? said : '(no answer given)'}`;
    });
    return `They answered:\n\n${lines.join('\n\n')}`;
  }
}
