// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { mermaidConfig, renderMermaid, type MermaidApi } from './mermaid-render';

/** A stand-in for mermaid 11 with error rendering on: a failed render leaves its scratch element on the body. */
function fakeMermaid(opts: { parses: boolean }): Pick<MermaidApi, 'parse' | 'render'> & { renders: number } {
  const api = {
    renders: 0,
    parse: vi.fn(async (text: string) => { if (!opts.parses) throw new Error(`Parse error on: ${text}`); return { diagramType: 'flowchart' }; }),
    render: vi.fn(async (id: string) => {
      api.renders++;
      for (const old of [id, `d${id}`, `i${id}`]) document.getElementById(old)?.remove(); // as mermaid does first
      const scratch = document.createElement('div');
      scratch.id = `d${id}`;
      scratch.innerHTML = '<svg><text>Syntax error in text</text></svg>';
      document.body.appendChild(scratch);
      if (!opts.parses) throw new Error('Syntax error in text');
      scratch.remove();
      return { svg: '<svg id="ok"></svg>' };
    }),
  };
  return api;
}

describe('renderMermaid', () => {
  it('returns the diagram when the source parses', async () => {
    const m = fakeMermaid({ parses: true });
    await expect(renderMermaid(m, 'cascade-mmd-1', 'graph TD; A-->B')).resolves.toBe('<svg id="ok"></svg>');
    expect(document.body.children.length).toBe(0);
  });

  it('does not render a source that does not parse, and throws', async () => {
    const m = fakeMermaid({ parses: false });
    await expect(renderMermaid(m, 'cascade-mmd-2', 'graph TD; A-->')).rejects.toThrow(/Parse error/);
    expect(m.renders).toBe(0);
    expect(document.body.innerHTML).not.toContain('Syntax error');
  });

  it('removes what a failed render left on the page', async () => {
    const m = fakeMermaid({ parses: false });
    m.parse = vi.fn(async () => ({}));  // parse passes, render still fails
    for (const id of ['d', 'i', '']) {
      const el = document.createElement('div');
      el.id = `${id}cascade-mmd-3`;
      document.body.appendChild(el);
    }
    await expect(renderMermaid(m, 'cascade-mmd-3', 'graph TD; A-->B')).rejects.toThrow(/Syntax error/);
    expect(document.body.children.length).toBe(0);
  });

  it('leaves other diagrams alone', async () => {
    const other = document.createElement('div');
    other.id = 'dcascade-mmd-9';
    document.body.appendChild(other);
    await expect(renderMermaid(fakeMermaid({ parses: false }), 'cascade-mmd-4', 'x')).rejects.toThrow();
    expect(document.getElementById('dcascade-mmd-9')).not.toBeNull();
    other.remove();
  });
});

describe('mermaidConfig', () => {
  it('turns off mermaid drawing its own error graphic', () => {
    expect(mermaidConfig('dark')).toMatchObject({ suppressErrorRendering: true, securityLevel: 'strict', startOnLoad: false, theme: 'dark' });
  });
});
