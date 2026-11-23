import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import CascadeMark from './CascadeMark.js';

// Animation is CSS, which jsdom doesn't run, so this reads it where it is declared.
const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../index.css'), 'utf8');
/** The block opening at `start`, to its matching brace. */
const block = (start: number): string => {
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
  }
  return css.slice(start);
};
/** The opacities a keyframes block steps through. */
const opacities = (name: string): number[] => {
  const start = css.indexOf(`@keyframes ${name} {`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  return [...block(start).matchAll(/opacity:\s*([\d.]+)/g)].map((m) => Number(m[1]));
};
/** Every rule for the lit arcs: its selector and its body. */
const litRules = (): Array<{ selector: string; body: string }> =>
  [...css.matchAll(/([^{}]*\.cascade-mark-lit > path\[data-on='1'\][^{}]*)\{([^}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));

afterEach(cleanup);

describe('the status mark, lit by the tiers working now', () => {
  it('marks the working tiers lit and the others idle', () => {
    const { container } = render(<CascadeMark lit={[2]} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('class')).toContain('cascade-mark-lit');
    expect([...svg.querySelectorAll('path')].map((p) => p.getAttribute('data-on'))).toEqual(['0', '0', '1']);
  });

  // The report: one tier working for minutes, and the mark looked frozen. A lit
  // arc breathed from 0.75 to 1, too shallow to read as moving.
  it('a lit arc pulses deep enough to be seen moving', () => {
    const steps = opacities('cascadeLit');
    expect(Math.max(...steps) - Math.min(...steps)).toBeGreaterThanOrEqual(0.5);
  });

  // With less motion asked for (the OS setting, or Settings → Reduce motion),
  // the lit arcs used to stop altogether: a busy run showed a still mark.
  it('with less motion asked for, it still pulses, without the travel', () => {
    const reduced = litRules().filter((r) => /animation\s*:/.test(r.body));
    expect(reduced.length).toBeGreaterThanOrEqual(3);
    for (const r of reduced) expect(r.body, r.selector).not.toMatch(/animation\s*:\s*none/);
    expect(css).not.toMatch(/\.cascade-mark-lit > path\[data-on='1'\],[^{]*\{\s*animation:\s*none/);
    const still = opacities('cascadeLitStill');
    expect(Math.max(...still) - Math.min(...still)).toBeGreaterThanOrEqual(0.5);
    expect(block(css.indexOf('@keyframes cascadeLitStill'))).not.toMatch(/transform/);
  });

  // Codex on 4943dcf: Settings → Reduce motion also sets every animation's
  // duration to 0.001ms and its count to 1, !important, on `*`. That outranks a
  // plain shorthand, so the pulse ran once and stopped.
  it("the app's Reduce motion setting doesn't cut the pulse to a single frame", () => {
    const global = block(css.indexOf(':root[data-reduce-motion="1"] *,'));
    expect(global).toMatch(/animation-duration:\s*0\.001ms !important/);
    const keep = /:root\[data-reduce-motion="1"\] \.cascade-mark-lit > path\[data-on='1'\] \{([^}]*)\}/.exec(css);
    expect(keep, 'an override for the lit arcs').not.toBeNull();
    expect(keep![1]).toMatch(/animation-duration:\s*[1-9][\d.]*s !important/);
    expect(keep![1]).toMatch(/animation-iteration-count:\s*infinite !important/);
  });

  it('several lit arcs light in tier order, top down', () => {
    expect(css).toMatch(/\.cascade-mark-lit > path:nth-child\(2\)\[data-on='1'\] \{ animation-delay: 0\.18s; \}/);
    expect(css).toMatch(/\.cascade-mark-lit > path:nth-child\(3\)\[data-on='1'\] \{ animation-delay: 0\.36s; \}/);
  });
});
