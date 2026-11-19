import { describe, it, expect } from 'vitest';
import { ReasoningStream, splitReasoning, withoutReasoning } from './reasoning.js';

describe('splitReasoning', () => {
  it('leaves a reply without reasoning exactly as it was', () => {
    expect(splitReasoning('  plain answer  ')).toEqual({ answer: '  plain answer  ', reasoning: '' });
  });

  it('sets a <think> block apart from the answer', () => {
    expect(splitReasoning('<think>\nweigh [a] and [b]\n</think>\n\n["real"]')).toEqual({
      answer: '["real"]',
      reasoning: 'weigh [a] and [b]',
    });
  });

  it('joins the blocks the reply opens with', () => {
    expect(splitReasoning('<think>one</think>\n<THINK>two</THINK> Answer')).toEqual({ answer: 'Answer', reasoning: 'one\n\ntwo' });
  });

  it('leaves a tag after the answer has begun as the answer\'s own text', () => {
    // A text tool call that writes a file containing the tags, or an
    // explanation that shows them: cutting them out would change the call.
    const call = '<tool_call>{"name":"file_write","input":{"path":"a.md","content":"<think>keep this text</think>"}}</tool_call>';
    expect(splitReasoning(call)).toEqual({ answer: call, reasoning: '' });
    expect(splitReasoning('<think>plan</think>A <think>two</think> B')).toEqual({ answer: 'A <think>two</think> B', reasoning: 'plan' });
  });

  it('reads a close with no open as reasoning the template began', () => {
    expect(splitReasoning('first I check the files.\n</think>\n\nDone.')).toEqual({
      answer: 'Done.',
      reasoning: 'first I check the files.',
    });
  });

  it('makes the rest of the reply reasoning when a leading block never closes', () => {
    expect(splitReasoning('  <think>ran out of tokens while')).toEqual({ answer: '', reasoning: 'ran out of tokens while' });
    expect(splitReasoning('Partial <think>not leading')).toEqual({ answer: 'Partial <think>not leading', reasoning: '' });
  });

  it('honours a leading <thinking> or <reasoning> block', () => {
    expect(splitReasoning('<thinking>plan</thinking>\nAnswer')).toEqual({ answer: 'Answer', reasoning: 'plan' });
    expect(splitReasoning('<reasoning>r</reasoning>A')).toEqual({ answer: 'A', reasoning: 'r' });
  });

  it('does not take a <thinking> tag in the middle of an answer for reasoning', () => {
    expect(withoutReasoning('Use the <thinking> element sparingly.')).toBe('Use the <thinking> element sparingly.');
  });

  it('gives an empty answer when the reply was only thinking', () => {
    expect(splitReasoning('<think>all thought</think>')).toEqual({ answer: '', reasoning: 'all thought' });
  });
});

describe('ReasoningStream', () => {
  const run = (chunks: string[]) => {
    const s = new ReasoningStream();
    let answer = '';
    let reasoning = '';
    for (const c of chunks) {
      const p = s.push(c);
      answer += p.answer;
      reasoning += p.reasoning;
    }
    const e = s.end();
    return { answer: answer + e.answer, reasoning: reasoning + e.reasoning };
  };

  it('splits a stream whose tags arrive whole', () => {
    expect(run(['<think>\n', 'hmm', '\n</think>\n\n', 'Hi'])).toEqual({ answer: '\n\nHi', reasoning: '\nhmm\n' });
  });

  it('holds back a tag cut across chunks', () => {
    expect(run(['<th', 'ink>deep</thi', 'nk>ok'])).toEqual({ answer: 'ok', reasoning: 'deep' });
  });

  it('releases a held tail that turned out not to be a tag', () => {
    expect(run(['a <t', 'able>'])).toEqual({ answer: 'a <table>', reasoning: '' });
  });

  it('stops reading tags once the answer has begun', () => {
    expect(run(['<think>a</think>Hi ', '<think>', 'not this</think>'])).toEqual({ answer: 'Hi <think>not this</think>', reasoning: 'a' });
  });

  it('streams nothing as reasoning before an orphan close, which the final split settles', () => {
    expect(run(['thinking', '</think>', 'answer'])).toEqual({ answer: 'thinking</think>answer', reasoning: '' });
  });
});
