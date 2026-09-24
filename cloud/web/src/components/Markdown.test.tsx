import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import Markdown from './Markdown.js';

describe('Markdown', () => {
  it('renders GFM tables and headings', () => {
    const { container, getByText } = render(<Markdown>{'# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |'}</Markdown>);
    expect(getByText('Title').tagName).toBe('H1');
    expect(container.querySelector('table')).toBeInTheDocument();
  });

  it('renders LaTeX math via KaTeX', () => {
    const { container } = render(<Markdown>{'The mass–energy relation is $E = mc^2$.'}</Markdown>);
    // rehype-katex emits .katex spans for math.
    expect(container.querySelector('.katex')).toBeInTheDocument();
  });

  it('renders \\[…\\] display maths as an equation, not as a bracketed string', () => {
    // As Gemini wrote it. Before, Markdown read `\[` as an escaped bracket and
    // the reader saw "[ r = \operatorname{rank} E(\mathbb{Q}) ]".
    const { container } = render(
      <Markdown>{'The rank is given by\n\\[ r = \\operatorname{rank} E(\\mathbb{Q}) \\]\nwhere r is finite.'}</Markdown>,
    );
    expect(container.querySelector('.katex-display')).toBeInTheDocument();
    // KaTeX keeps the TeX in a MathML annotation for screen readers, so look
    // at what is left outside the rendered equation: no raw source there.
    const prose = container.cloneNode(true) as HTMLElement;
    prose.querySelectorAll('.katex').forEach((el) => el.remove());
    expect(prose.textContent).not.toContain('\\operatorname');
    expect(prose.textContent).not.toContain('[ r =');
  });

  it('renders \\(…\\) inline maths', () => {
    const { container } = render(<Markdown>{'where \\(n^2\\) is even'}</Markdown>);
    expect(container.querySelector('.katex')).toBeInTheDocument();
    expect(container.querySelector('.katex-display')).not.toBeInTheDocument();
    expect(container.textContent).not.toContain('\\(');
  });

  it('leaves prices as prices', () => {
    // remark-math pairs any two dollars: this rendered "5 and " as maths.
    const { container } = render(<Markdown>{'It costs $5 and $10 per month.'}</Markdown>);
    expect(container.querySelector('.katex')).not.toBeInTheDocument();
    expect(container.textContent).toBe('It costs $5 and $10 per month.');
  });

  it('keeps maths and a price apart in one sentence', () => {
    const { container } = render(<Markdown>{'Between $5 and $10, i.e. $x$ dollars.'}</Markdown>);
    expect(container.querySelectorAll('.katex')).toHaveLength(1);
    expect(container.textContent).toContain('Between $5 and $10, i.e.');
  });

  it('leaves maths delimiters in a code block alone', () => {
    const { container } = render(<Markdown>{'```latex\n\\[ x^2 \\]\n```'}</Markdown>);
    expect(container.querySelector('.katex')).not.toBeInTheDocument();
    expect(container.querySelector('pre code')?.textContent).toContain('\\[ x^2 \\]');
  });

  it('highlights a fenced code block and adds a copy button', () => {
    const { container, getByLabelText } = render(<Markdown>{'```ts\nconst x: number = 1;\n```'}</Markdown>);
    expect(container.querySelector('pre code')).toBeInTheDocument();
    expect(getByLabelText('Copy')).toBeInTheDocument();
  });

  it('routes a ```mermaid block to the diagram renderer (not a code block)', () => {
    const { getByText } = render(<Markdown>{'```mermaid\ngraph TD; A-->B;\n```'}</Markdown>);
    // Mermaid loads lazily; before the async import resolves it shows a loader.
    expect(getByText(/Rendering diagram/i)).toBeInTheDocument();
  });

  it('does NOT render raw HTML from the model (no rehype-raw)', () => {
    const { container } = render(<Markdown>{'<img src=x onerror="alert(1)"> hello'}</Markdown>);
    // The <img> must not become a real element — it stays inert text.
    expect(container.querySelector('img')).not.toBeInTheDocument();
  });
});
