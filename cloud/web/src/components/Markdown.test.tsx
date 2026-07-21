import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';
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
