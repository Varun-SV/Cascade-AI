// ─────────────────────────────────────────────
//  Cascade AI — A model's reasoning, apart from its answer
// ─────────────────────────────────────────────
//
//  Reasoning models put their thinking in the reply itself. The Anthropic and
//  OpenAI-compatible providers wrap it in `<think>…</think>` (see
//  providers/anthropic.ts and providers/openai.ts), and local reasoning models
//  (DeepSeek R1, Qwen3, QwQ and their GGUF builds) write the same tags
//  themselves. Some chat templates open the block inside the prompt, so the
//  reply starts with the reasoning and carries only the closing `</think>`.
//
//  The thinking is for the person to read, not for the next parser. A plan
//  parser that meets `[` inside the thinking reads the wrong array; a worker's
//  output that carries its thinking hands it to the manager as if it were the
//  result, and every later turn pays for it again.

const OPEN = /<think>/i;
const CLOSE = /<\/think>/i;
/** Other names some models use, honoured only as the reply's first block. */
const LEADING_OTHER = /^\s*<(thinking|reasoning)>([\s\S]*?)(?:<\/\1>|$)/i;

export interface Split {
  /** The reply without its reasoning. */
  answer: string;
  /** The reasoning, blocks joined by a blank line; empty when there is none. */
  reasoning: string;
}

/**
 * A reply's answer and reasoning, apart.
 *
 * - the `<think>…</think>` blocks the reply OPENS with are reasoning;
 * - a `</think>` with no `<think>` before it closes reasoning that began at the
 *   start of the reply (the template opened it);
 * - a leading `<think>` that never closes (the model ran out of tokens while
 *   thinking) makes the rest of the reply reasoning;
 * - a leading `<thinking>` or `<reasoning>` block is reasoning too.
 *
 * Only leading blocks: models and providers put their thinking before the
 * answer. A `<think>` tag later in the reply is the answer's own text — the
 * content of a file a tool call writes, an example in an explanation — and
 * cutting it out would change what the call does.
 */
export function splitReasoning(text: string): Split {
  if (!text) return { answer: text ?? '', reasoning: '' };
  const thoughts: string[] = [];
  let rest = text;

  const lead = LEADING_OTHER.exec(rest);
  if (lead) {
    thoughts.push(lead[2]!.trim());
    rest = rest.slice(lead[0].length);
  }

  // A close before any open: the reasoning started before the reply did.
  const firstClose = CLOSE.exec(rest);
  const firstOpen = OPEN.exec(rest);
  if (firstClose && (!firstOpen || firstClose.index < firstOpen.index)) {
    thoughts.push(rest.slice(0, firstClose.index).trim());
    rest = rest.slice(firstClose.index + firstClose[0].length);
  }

  for (;;) {
    const lead = /^\s*<think>/i.exec(rest);
    if (!lead) break;
    const after = rest.slice(lead[0].length);
    const close = CLOSE.exec(after);
    if (!close) { thoughts.push(after.trim()); rest = ''; break; }
    thoughts.push(after.slice(0, close.index).trim());
    rest = after.slice(close.index + close[0].length);
  }
  const answer = rest;

  const reasoning = thoughts.filter(Boolean).join('\n\n');
  if (!reasoning && thoughts.length === 0) return { answer: text, reasoning: '' };
  return { answer: answer.trim(), reasoning };
}

/** A reply without its reasoning. */
export function withoutReasoning(text: string): string {
  return splitReasoning(text).answer;
}

const TAG_OPEN = '<think>';
const TAG_CLOSE = '</think>';

/**
 * The same split, a streamed chunk at a time, for showing thinking while it
 * happens. A tag cut across two chunks is held back until it can be read.
 *
 * Only leading `<think>` blocks are seen here, as in `splitReasoning`: once
 * the answer has begun, a later tag is the answer's own text. A reply whose
 * thinking began before it did (an orphan `</think>`) can't be told apart
 * from an answer until the close arrives, so the caller settles on
 * `splitReasoning` of the whole reply when the call ends.
 */
export class ReasoningStream {
  private inside = false;
  private held = '';
  /** The answer has begun: no later tag opens reasoning. */
  private answered = false;

  /** The answer and reasoning text in this chunk. */
  push(chunk: string): Split {
    let text = this.held + chunk;
    this.held = '';
    let answer = '';
    let reasoning = '';
    for (;;) {
      if (this.answered) { answer += text; break; }
      if (this.inside) {
        const at = text.toLowerCase().indexOf(TAG_CLOSE);
        if (at === -1) {
          // Keep back a tail that could be the start of the closing tag.
          const keep = partialTagTail(text, TAG_CLOSE);
          reasoning += text.slice(0, text.length - keep);
          this.held = text.slice(text.length - keep);
          break;
        }
        reasoning += text.slice(0, at);
        text = text.slice(at + TAG_CLOSE.length);
        this.inside = false;
        continue;
      }
      // Outside a block, before any answer: whitespace, then maybe a tag.
      const lead = text.length - text.trimStart().length;
      const rest = text.slice(lead).toLowerCase();
      answer += text.slice(0, lead);
      if (!rest) break;
      if (rest.startsWith(TAG_OPEN)) {
        text = text.slice(lead + TAG_OPEN.length);
        this.inside = true;
        continue;
      }
      if (TAG_OPEN.startsWith(rest)) { this.held = text.slice(lead); break; }
      this.answered = true;
      text = text.slice(lead);
    }
    return { answer, reasoning };
  }

  /** Whatever was held back, once the stream has ended. */
  end(): Split {
    const rest = this.held;
    this.held = '';
    return this.inside ? { answer: '', reasoning: rest } : { answer: rest, reasoning: '' };
  }
}

/** How many trailing characters of `text` could be the start of `tag`. */
function partialTagTail(text: string, tag: string): number {
  const lower = text.toLowerCase();
  for (let n = Math.min(tag.length - 1, lower.length); n > 0; n--) {
    if (lower.endsWith(tag.slice(0, n))) return n;
  }
  return 0;
}
