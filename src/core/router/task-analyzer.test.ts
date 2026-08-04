import { describe, expect, it } from 'vitest';
import { TaskAnalyzer } from './task-analyzer.js';

describe('TaskAnalyzer.analyze — profile cache', () => {
  it('does not let two tasks sharing a preamble collide on the cache key', async () => {
    // Regression: the key was `prompt.slice(0, 200)`. Long shared preambles are
    // the norm, not the exception — a repo header, a "You are working in X"
    // block, a pasted stack trace — so the second task silently inherited the
    // first's profile. That profile picks the tier and model, so a trivial
    // follow-up could be routed as research-grade work, or the reverse.
    const preamble = 'Context: '.repeat(30); // comfortably over 200 chars
    expect(preamble.length).toBeGreaterThan(200);

    const analyzer = new TaskAnalyzer();
    const simple = await analyzer.analyze(`${preamble}say hi`);
    const complex = await analyzer.analyze(
      `${preamble}Design and implement a distributed microservice architecture with `
      + 'comprehensive performance optimization across the entire codebase, migrating '
      + 'multiple components and refactoring several systems end to end.',
    );

    // Different work must get different profiles. Under the truncated key these
    // were the same object.
    expect(complex.complexity).toBeGreaterThan(simple.complexity);
    expect(complex).not.toBe(simple);
  });

  it('still caches — an identical prompt returns the identical profile object', async () => {
    const analyzer = new TaskAnalyzer();
    const prompt = 'Refactor the auth module and add tests';
    const first = await analyzer.analyze(prompt);
    const second = await analyzer.analyze(prompt);
    expect(second).toBe(first);
  });
});
