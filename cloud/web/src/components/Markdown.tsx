import { useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import { Copy, Check } from 'lucide-react';
import 'katex/dist/katex.min.css';
import Mermaid from './Mermaid.js';

// Extract the plain-text content of a react-markdown code node, whatever the
// children shape (string, array, or highlighted spans get flattened by innerText
// at copy time — this handles the pre-highlight case for mermaid detection).
function nodeText(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(nodeText).join('');
  if (children && typeof children === 'object' && 'props' in children) {
    return nodeText((children as { props?: { children?: ReactNode } }).props?.children);
  }
  return '';
}

function CopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useCopied();
  return (
    <button
      type="button"
      aria-label="Copy"
      onClick={() => { void navigator.clipboard.writeText(getText()); setCopied(); }}
      className="absolute right-2 top-2 rounded-md border border-elev/10 bg-elev/10 p-1.5 text-ink-200 opacity-100 backdrop-blur transition-opacity hover:text-ink-50 sm:opacity-0 sm:group-hover:opacity-100"
    >
      {copied ? <Check size={14} className="text-success-500" /> : <Copy size={14} />}
    </button>
  );
}

function useCopied(): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  return [copied, () => { setCopied(true); setTimeout(() => setCopied(false), 1200); }];
}

/**
 * The one place chat + the file viewer turn markdown into rich output:
 *   - GFM tables/task-lists/strikethrough (remark-gfm)
 *   - LaTeX math, $inline$ and $$block$$ (remark-math + rehype-katex)
 *   - syntax-highlighted code with a copy button (rehype-highlight)
 *   - ```mermaid fenced blocks rendered as diagrams (lazy-loaded)
 * Raw HTML in the markdown is NOT rendered (no rehype-raw) — untrusted model
 * output must not inject markup.
 */
export default function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[
        rehypeKatex,
        [rehypeHighlight, { detect: true, ignoreMissing: true }],
      ]}
      components={{
        pre: PreBlock,
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

// A fenced block. If it's ```mermaid, render a diagram (no code chrome);
// otherwise the usual highlighted <pre> with a copy button.
function PreBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const codeChild = Array.isArray(children) ? children[0] : children;
  const className: string =
    (codeChild && typeof codeChild === 'object' && 'props' in codeChild
      ? (codeChild as { props?: { className?: string } }).props?.className ?? ''
      : '') || '';

  if (/\blanguage-mermaid\b/.test(className)) {
    return <Mermaid code={nodeText(children).replace(/\n$/, '')} />;
  }
  return (
    <div className="group relative">
      <CopyButton getText={() => ref.current?.innerText ?? ''} />
      <pre ref={ref} className="overflow-x-auto rounded-xl border border-elev/10 bg-black/40 p-3 text-sm shadow-inner">
        {children}
      </pre>
    </div>
  );
}
