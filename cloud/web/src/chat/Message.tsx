import { useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Copy, Check, RotateCcw } from 'lucide-react';
import { uploadUrl } from '../lib/api.js';
import type { ChatMessage } from './useChatSession.js';

function CopyButton({ getText, className }: { getText: () => string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy"
      onClick={() => {
        void navigator.clipboard.writeText(getText());
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className={className ?? 'text-ink-400 hover:text-ink-100'}
    >
      {copied ? <Check size={14} className="text-success-500" /> : <Copy size={14} />}
    </button>
  );
}

// Wraps every fenced code block with a copy button. rehype-highlight has
// already coloured the inner <code>; we only add the affordance + chrome.
function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="group relative">
      <CopyButton
        getText={() => ref.current?.innerText ?? ''}
        className="absolute right-2 top-2 rounded-md bg-ink-800/80 p-1.5 text-ink-300 opacity-0 transition-opacity hover:text-ink-50 group-hover:opacity-100"
      />
      <pre ref={ref} className="overflow-x-auto rounded-lg border border-ink-700 bg-ink-950 p-3 text-sm">
        {children}
      </pre>
    </div>
  );
}

interface Props {
  message: ChatMessage;
  onRegenerate?: () => void;
}

export default function Message({ message, onRegenerate }: Props) {
  const images = (message.attachments ?? []).filter((a) => a.mime.startsWith('image/'));

  if (message.role === 'user') {
    return (
      <div data-role="user" className="flex flex-col items-end gap-2">
        {images.length > 0 && (
          <div className="flex flex-wrap justify-end gap-2">
            {images.map((a) => (
              <img
                key={a.id}
                src={uploadUrl(a.id)}
                alt="attachment"
                className="max-h-40 rounded-lg border border-ink-700 object-cover"
              />
            ))}
          </div>
        )}
        {message.content && (
          <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-accent-600/90 px-4 py-2 text-white">
            {message.content}
          </div>
        )}
      </div>
    );
  }

  return (
    <div data-role="assistant" className="group flex flex-col gap-1.5">
      <span className="text-xs font-medium text-ink-400">Cascade</span>
      <div className="prose prose-invert prose-sm max-w-none text-ink-100">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
          components={{ pre: ({ children }) => <CodeBlock>{children}</CodeBlock> }}
        >
          {message.content || (message.streaming ? '…' : '')}
        </ReactMarkdown>
      </div>
      {!message.streaming && message.content && (
        <div className="flex items-center gap-2 pt-0.5 text-ink-400 opacity-0 transition-opacity group-hover:opacity-100">
          <CopyButton getText={() => message.content} />
          {onRegenerate && (
            <button type="button" aria-label="Regenerate" onClick={onRegenerate} className="hover:text-ink-100">
              <RotateCcw size={14} />
            </button>
          )}
          {typeof message.costUsd === 'number' && message.costUsd > 0 && (
            <span className="ml-1 text-[11px] tabular-nums">${message.costUsd.toFixed(4)}</span>
          )}
        </div>
      )}
    </div>
  );
}
