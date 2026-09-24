import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { CHAT_REHYPE_PLUGINS, CHAT_REMARK_PLUGINS, prepareAnswer } from './markdown.js';

// Renders exactly as the desktop chat does: the same plugins, the same
// preparation. There is no React test harness in app/src, and none is needed
// for this — static markup is what decides whether an equation was typeset.
function render(answer: string): string {
  return renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: CHAT_REMARK_PLUGINS,
    rehypePlugins: CHAT_REHYPE_PLUGINS,
  }, prepareAnswer(answer)));
}

/** Visible text: tags dropped, and KaTeX's MathML source annotation with them. */
function visibleText(html: string): string {
  return html.replace(/<annotation[^>]*>[^<]*<\/annotation>/g, '').replace(/<[^>]+>/g, '');
}

describe('desktop chat maths', () => {
  it('typesets \\[…\\] as display maths', () => {
    const html = render('The rank is given by\n\\[ r = \\operatorname{rank} E(\\mathbb{Q}) \\]\nwhere r is finite.');
    expect(html).toContain('katex-display');
    expect(visibleText(html)).not.toContain('\\operatorname');
  });

  it('typesets \\(…\\) and $…$ inline', () => {
    const html = render('where \\(n\\) is prime and $x^2$ is even');
    expect(html.match(/class="katex"/g)).toHaveLength(2);
  });

  it('leaves prices as prices', () => {
    const html = render('It costs $5 and $10 per month.');
    expect(html).not.toContain('katex');
    expect(visibleText(html)).toBe('It costs $5 and $10 per month.');
  });

  it('still renders GFM tables', () => {
    expect(render('| a | b |\n|---|---|\n| 1 | 2 |')).toContain('<table>');
  });
});
