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
          <div className="flex h-full items-center justify-center text-center text-cascade-400">
            <div>
              <p className="text-lg font-medium text-cascade-200">Start a conversation</p>
              <p className="mt-1 text-sm">Cascade routes your prompt through its T1/T2/T3 orchestration and streams the result here.</p>
            </div>
          </div>
        )}
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {messages.map((m) => (
            <div key={m.id} data-role={m.role} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
              <div
                className={
                  m.role === 'user'
                    ? 'max-w-[80%] rounded-2xl rounded-br-sm bg-cascade-600 px-4 py-2 text-white'
                    : 'max-w-[80%] rounded-2xl rounded-bl-sm bg-cascade-950/70 px-4 py-2 text-cascade-100'
                }
              >
                <div className="prose prose-invert prose-sm max-w-none">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content || (m.streaming ? '…' : '')}</ReactMarkdown>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {error && (
        <div className="mx-6 mb-2 flex items-center gap-2 rounded-md border border-red-800 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          <AlertTriangle size={14} />
          <span>{error}</span>
        </div>
      )}

      {!hasProviders && (
        <div className="mx-6 mb-2 flex items-center gap-2 rounded-md border border-cascade-700 bg-cascade-950/40 px-3 py-2 text-sm text-cascade-300">
          <KeyRound size={14} />
          <span>Add a provider key before starting a chat.</span>
        </div>
      )}

      <div className="border-t border-cascade-900 px-6 py-4">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            className="max-h-40 min-h-[44px] flex-1 resize-none rounded-md bg-cascade-950 px-3 py-2 text-sm text-cascade-100 outline-none focus:ring-1 focus:ring-cascade-500"
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
            className="flex h-[44px] w-[44px] items-center justify-center rounded-md bg-cascade-600 text-white hover:bg-cascade-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
