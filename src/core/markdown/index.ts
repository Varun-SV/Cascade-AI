// ─────────────────────────────────────────────
//  Cascade AI — Shared Markdown rendering steps
// ─────────────────────────────────────────────
//
//  Imported by cloud/web and the desktop renderer through the
//  `@cascade/markdown` alias. Kept free of DOM and Node imports so it bundles
//  into either unchanged; its one dependency, micromark with the GFM
//  extension, is the parser react-markdown and remark-gfm already bring.

export { createMathNormalizer, normalizeMath } from './math.js';
