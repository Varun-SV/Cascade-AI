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
 * - every `<think>…</think>` block is reasoning;
 * - a `</think>` with no `<think>` before it closes reasoning that began at the
 *   start of the reply (the template opened it);
 * - a `<think>` that never closes (the model ran out of tokens while thinking)
 *   makes the rest of the reply reasoning;
 * - a leading `<thinking>` or `<reasoning>` block is reasoning too.
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

  let answer = '';
  for (;;) {
    const open = OPEN.exec(rest);
    if (!open) { answer += rest; break; }
    answer += rest.slice(0, open.index);
    const after = rest.slice(open.index + open[0].length);
    const close = CLOSE.exec(after);
    if (!close) { thoughts.push(after.trim()); break; }
    thoughts.push(after.slice(0, close.index).trim());
    rest = after.slice(close.index + close[0].length);
  }

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
 * Only `<think>` blocks are seen here: a reply whose thinking began before it
 * did (an orphan `</think>`) can't be told apart from an answer until the close
 * arrives, so the caller settles on `splitReasoning` of the whole reply when
 * the call ends.
 */
export class ReasoningStream {
  private inside = false;
  private held = '';

  /** The answer and reasoning text in this chunk. */
  push(chunk: string): Split {
    let text = this.held + chunk;
    this.held = '';
    let answer = '';
    let reasoning = '';
    for (;;) {
      const tag = this.inside ? TAG_CLOSE : TAG_OPEN;
      const at = text.toLowerCase().indexOf(tag);
      if (at === -1) {
        // Keep back a tail that could be the start of the tag.
        const keep = partialTagTail(text, tag);
        const out = text.slice(0, text.length - keep);
        this.held = text.slice(text.length - keep);
        if (this.inside) reasoning += out; else answer += out;
        break;
      }
      if (this.inside) reasoning += text.slice(0, at); else answer += text.slice(0, at);
      text = text.slice(at + tag.length);
      this.inside = !this.inside;
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
