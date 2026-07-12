import { useState, type KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Send, AlertTriangle, KeyRound } from 'lucide-react';
import type { ChatMessage } from './useChatSession.js';

interface Props {
  messages: ChatMessage[];
  busy: boolean;
  error: string | null;
  hasProviders: boolean;
  onSend: (prompt: string) => void;
}

export default function ChatPanel({ messages, busy, error, hasProviders, onSend }: Props) {
  const [input, setInput] = useState('');

  function submit() {
    if (!input.trim()) return;
    onSend(input);
    setInput('');
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center text-center text-ink-400">
            <div>
              <p className="text-lg font-medium text-ink-200">Start a conversation</p>
              <p className="mt-1 text-sm">Cascade routes your prompt through its T1/T2/T3 orchestration and streams the result here.</p>
            </div>
          </div>
        )}
        <div className="mx-auto flex max-w-3xl flex-col gap-5">
          {messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} data-role={m.role} className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-accent-600/90 px-4 py-2 text-white">
                  <div className="prose prose-invert prose-sm max-w-none">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                  </div>
                </div>
              </div>
            ) : (
              <div key={m.id} data-role={m.role} className="flex flex-col gap-1">
                <span className="text-xs font-medium text-ink-400">Cascade</span>
                <div className="prose prose-invert prose-sm max-w-none text-ink-100">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content || (m.streaming ? '…' : '')}</ReactMarkdown>
                </div>
              </div>
            ),
          )}
        </div>
      </div>

      {error && (
        <div className="mx-6 mb-2 flex items-center gap-2 rounded-md border border-danger-800 bg-danger-950/40 px-3 py-2 text-sm text-danger-300">
          <AlertTriangle size={14} />
          <span>{error}</span>
        </div>
      )}

      {!hasProviders && (
        <div className="mx-6 mb-2 flex items-center gap-2 rounded-md border border-info-800 bg-info-950/40 px-3 py-2 text-sm text-info-300">
          <KeyRound size={14} />
          <span>Add a provider key before starting a chat.</span>
        </div>
      )}

      <div className="px-6 py-4">
        <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-ink-700 bg-ink-900 px-2 py-1.5">
          <textarea
            className="max-h-40 min-h-[32px] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-ink-100 outline-none placeholder:text-ink-400"
            placeholder="Message Cascade…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={busy || !hasProviders}
            rows={1}
          />
          <button
            type="button"
            onClick={submit}
            disabled={busy || !hasProviders || !input.trim()}
            aria-label="Send"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-500 text-ink-950 hover:bg-accent-400 disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-ink-400"
          >
            <Send size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
