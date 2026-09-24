import type { Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { normalizeMath } from '@cascade/markdown';

/**
 * The chat's Markdown pipeline, kept here so ChatPanel and its test render
 * with the same plugins. The web chat has used the same set since 0.x; the
 * desktop rendered GFM only, so every equation reached the reader as raw TeX.
 */
export const CHAT_REMARK_PLUGINS: Options['remarkPlugins'] = [remarkGfm, remarkMath];
export const CHAT_REHYPE_PLUGINS: Options['rehypePlugins'] = [rehypeKatex];

/**
 * An answer as the pipeline should read it: `\(…\)`, `\[…\]` and bare
 * environments rewritten as dollars, prices escaped. See src/core/markdown.
 */
export function prepareAnswer(answer: string): string {
  return normalizeMath(answer);
}
