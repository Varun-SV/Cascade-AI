// ─────────────────────────────────────────────
//  Cascade AI — Shared Markdown rendering steps
// ─────────────────────────────────────────────
//
//  Imported by cloud/web and the desktop renderer through the
//  `@cascade/markdown` alias. Kept free of DOM and Node imports so it bundles
//  into either unchanged. It depends only on what both already run: micromark
//  with the GFM extension, the parser react-markdown and remark-gfm bring, and
//  React, hoisted to one copy for the whole workspace.

export { createMathNormalizer, normalizeMath } from './math.js';
export { usePacedText } from './pace.js';
