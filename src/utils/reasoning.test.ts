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

  it('joins several blocks and keeps the text between them', () => {
    const s = splitReasoning('<think>one</think>A <THINK>two</THINK> B');
    expect(s.reasoning).toBe('one\n\ntwo');
    expect(s.answer).toBe('A  B');
  });

  it('reads a close with no open as reasoning the template began', () => {
    expect(splitReasoning('first I check the files.\n</think>\n\nDone.')).toEqual({
      answer: 'Done.',
      reasoning: 'first I check the files.',
    });
  });

  it('makes the rest of the reply reasoning when a block never closes', () => {
    expect(splitReasoning('Partial <think>ran out of tokens while')).toEqual({
      answer: 'Partial',
      reasoning: 'ran out of tokens while',
    });
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

  it('streams nothing as reasoning before an orphan close, which the final split settles', () => {
    expect(run(['thinking', '</think>', 'answer'])).toEqual({ answer: 'thinking</think>answer', reasoning: '' });
  });
});
