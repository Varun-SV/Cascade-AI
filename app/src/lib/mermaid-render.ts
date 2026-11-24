// ─────────────────────────────────────────────
//  Cascade AI — Rendering one Mermaid diagram without leaving anything behind
// ─────────────────────────────────────────────
//
//  Mermaid 11's render() draws into a scratch element it appends to
//  document.body (`d<id>`, or `i<id>` for a sandboxed render). When the source
//  doesn't parse, and error rendering isn't suppressed, it draws its own
//  "Syntax error in text" graphic into that element and throws *before* it
//  removes it, so the bomb stays on the page, below everything else. A reply
//  that is still streaming a diagram fails to parse on almost every chunk, so a
//  single answer could leave several.
//
//  So: error rendering is off, the source is parsed before it is rendered, and
//  whatever render() left behind is removed when it fails anyway.

/** The part of the mermaid module this uses. */
export interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  parse(text: string): Promise<unknown>;
  render(id: string, text: string): Promise<{ svg: string }>;
}

/** The config every Cascade diagram is rendered with, plus the theme. */
export function mermaidConfig(theme: 'dark' | 'default'): Record<string, unknown> {
  return { startOnLoad: false, theme, securityLevel: 'strict', suppressErrorRendering: true };
}

/** The scratch elements render(id) may have added to the document. */
export const scratchIds = (id: string): string[] => [id, `d${id}`, `i${id}`];

/**
 * The diagram as SVG. Throws when the source doesn't parse or render, having
 * removed anything render() left in the document.
 */
export async function renderMermaid(
  mermaid: Pick<MermaidApi, 'parse' | 'render'>,
  id: string,
  code: string,
  doc: Pick<Document, 'getElementById'> = document,
): Promise<string> {
  try {
    await mermaid.parse(code);
    return (await mermaid.render(id, code)).svg;
  } catch (e) {
    for (const el of scratchIds(id)) doc.getElementById(el)?.remove();
    throw e;
  }
}
