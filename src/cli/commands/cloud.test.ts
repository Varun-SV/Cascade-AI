import { describe, it, expect } from 'vitest';
import { formatCloudTranscript } from './cloud.js';

describe('formatCloudTranscript', () => {
  it('renders roles, short ids, and content', () => {
    const out = formatCloudTranscript([
      { id: 'abcdef123456', role: 'user', content: 'hello there' },
      { id: 'fedcba654321', role: 'assistant', content: 'hi back' },
    ]);
    expect(out).toContain('You');
    expect(out).toContain('Cascade');
    expect(out).toContain('[abcdef12]'); // short id (first 8 chars)
    expect(out).toContain('hello there');
    expect(out).toContain('hi back');
  });

  it('shows a ‹i/n› marker only when a turn has siblings', () => {
    const out = formatCloudTranscript([
      { id: 'm2', role: 'user', content: 'edited prompt', siblingIds: ['m1', 'm2'] },
      { id: 'a1', role: 'assistant', content: 'an answer', siblingIds: ['a1'] },
    ]);
    expect(out).toContain('‹2/2›');       // m2 is the 2nd of 2 sibling prompts
    expect(out).not.toContain('‹1/1›');   // a lone reply gets no marker
  });

  it('indents multi-line content under the turn', () => {
    const out = formatCloudTranscript([{ id: 'x', role: 'assistant', content: 'line1\nline2' }]);
    expect(out).toContain('  line1\n  line2');
  });
});
