import { useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { AnimatePresence, motion } from 'framer-motion';
import { Copy, Check, RotateCcw, ChevronDown } from 'lucide-react';
import { uploadUrl } from '../lib/api.js';
import type { ChatMessage } from './useChatSession.js';
import type { WhyReport } from '../lib/types.js';

// Tier accent colors match the run-explorer design (T1 green / T2 amber /
// T3 violet), rendered as subtle tinted chips over the existing dark surface.
const TIER_STYLE: Record<string, string> = {
  T1: 'text-[#4ade80] bg-[#4ade80]/12 ring-[#4ade80]/25',
  T2: 'text-[#f0b429] bg-[#f0b429]/12 ring-[#f0b429]/25',
  T3: 'text-[#c084fc] bg-[#c084fc]/12 ring-[#c084fc]/25',
};

function TierBadge({ tier }: { tier: string }) {
  return (
    <span
      className={`rounded-md px-1.5 py-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-wide ring-1 ${
        TIER_STYLE[tier] ?? 'text-ink-300 bg-white/5 ring-white/10'
      }`}
    >
      {tier}
    </span>
  );
}

const KIND_DOT: Record<string, string> = {
  complexity: 'bg-info-500',
  model: 'bg-accent-500',
  failover: 'bg-warning-500',
  escalation: 'bg-danger-500',
};

function WhyPanel({ why }: { why: WhyReport }) {
  const tiers = Object.keys(why.costByTier).filter((t) => (why.costByTier[t] ?? 0) > 0);
  return (
    <div className="mt-1 rounded-lg border border-white/10 bg-black/30 p-3 text-xs text-ink-300">
      {why.savedUsd > 0 && (
        <p className="mb-2 text-success-300">
          Saved <span className="font-mono">${why.savedUsd.toFixed(4)}</span> ({why.savedPct}%) by delegating below the
          top tier.
        </p>
      )}
      {why.decisions.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {why.decisions.map((d, i) => (
            <li key={i} className="flex gap-2">
              <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${KIND_DOT[d.kind] ?? 'bg-ink-400'}`} />
              <span className="leading-snug">
                <span className="font-mono text-[10.5px] uppercase text-ink-400">{d.kind}</span> · {d.detail}
              </span>
            </li>
          ))}
        </ul>
      )}
      {tiers.length > 0 && (
        <div className="mt-2 flex flex-col gap-1 border-t border-white/10 pt-2">
          {tiers.map((t) => (
            <div key={t} className="flex items-center justify-between font-mono text-[11px]">
              <span>{t}{why.models[t] ? ` · ${why.models[t]}` : ''}</span>
              <span className="text-ink-400">${(why.costByTier[t] ?? 0).toFixed(4)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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
        className="absolute right-2 top-2 rounded-md border border-white/10 bg-white/10 p-1.5 text-ink-200 opacity-100 backdrop-blur transition-opacity hover:text-ink-50 sm:opacity-0 sm:group-hover:opacity-100"
      />
      <pre ref={ref} className="overflow-x-auto rounded-xl border border-white/10 bg-black/40 p-3 text-sm shadow-inner">
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
  const [whyOpen, setWhyOpen] = useState(false);

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
                className="max-h-40 rounded-xl border border-white/10 object-cover shadow-lg"
              />
            ))}
          </div>
        )}
        {message.content && (
          <div className="accent-grad max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md px-4 py-2 font-medium text-ink-950 shadow-lg shadow-accent-700/20">
            {message.content}
          </div>
        )}
      </div>
    );
  }

  return (
    <div data-role="assistant" className="group flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-ink-400">
        {message.tier ? (
          <TierBadge tier={message.tier} />
        ) : (
          <span className="accent-grad h-2 w-2 rounded-full" />
        )}
        <span>Cascade</span>
        {message.model && <span className="text-ink-500">{message.model}</span>}
        {message.cancelled && (
          <span className="rounded bg-danger-500/15 px-1.5 py-0.5 text-[10px] font-medium text-danger-300">stopped</span>
        )}
        {message.why && (
          <button
            type="button"
            onClick={() => setWhyOpen((o) => !o)}
            className="flex items-center gap-0.5 font-mono text-[11px] text-ink-500 hover:text-ink-300"
          >
            /why
            <ChevronDown size={11} className={whyOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {whyOpen && message.why && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <WhyPanel why={message.why} />
          </motion.div>
        )}
      </AnimatePresence>
      {message.streaming && !message.content ? (
        <span className="shimmer-text text-sm">Composing a response…</span>
      ) : (
        <div className="prose prose-invert prose-sm max-w-none text-ink-100">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
            components={{ pre: ({ children }) => <CodeBlock>{children}</CodeBlock> }}
          >
            {message.content}
          </ReactMarkdown>
        </div>
      )}
      {!message.streaming && message.content && (
        <div className="flex items-center gap-2 pt-0.5 text-ink-400 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
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
