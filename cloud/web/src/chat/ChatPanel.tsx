import { useEffect, useRef } from 'react';
import { AlertTriangle, KeyRound, Loader2 } from 'lucide-react';
import Message from './Message.js';
import Composer from './Composer.js';
import type { ChatMessage, SendInput } from './useChatSession.js';
import type { Skill } from '../lib/types.js';

interface Props {
  messages: ChatMessage[];
  busy: boolean;
  error: string | null;
  status: string | null;
  hasProviders: boolean;
  skills: Skill[];
  skillId: string;
  onSkillChange: (id: string) => void;
  onSend: (input: SendInput) => void;
  onRegenerate: () => void;
}

export default function ChatPanel({
  messages, busy, error, status, hasProviders, skills, skillId, onSkillChange, onSend, onRegenerate,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastAssistantId = [...messages].reverse().find((m) => m.role === 'assistant' && !m.streaming)?.id;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, status]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center text-center text-ink-400">
            <div>
              <p className="text-lg font-medium text-ink-200">Start a conversation</p>
              <p className="mt-1 text-sm">
                Cascade routes your prompt through its T1/T2/T3 orchestration and streams the result here.
              </p>
            </div>
          </div>
        )}
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          {messages.map((m) => (
            <Message key={m.id} message={m} onRegenerate={m.id === lastAssistantId ? onRegenerate : undefined} />
          ))}
          {status && busy && (
            <div className="flex items-center gap-2 text-sm text-ink-400">
              <Loader2 size={14} className="animate-spin text-accent-500" />
              <span>{status}</span>
            </div>
          )}
        </div>
        <div ref={bottomRef} />
      </div>

      {error && (
        <div className="mx-4 mb-2 flex items-center gap-2 rounded-md border border-danger-800 bg-danger-950/40 px-3 py-2 text-sm text-danger-300 sm:mx-6">
          <AlertTriangle size={14} />
          <span>{error}</span>
        </div>
      )}

      {!hasProviders && (
        <div className="mx-4 mb-2 flex items-center gap-2 rounded-md border border-info-800 bg-info-950/40 px-3 py-2 text-sm text-info-300 sm:mx-6">
          <KeyRound size={14} />
          <span>Add a provider key before starting a chat.</span>
        </div>
      )}

      <Composer
        skills={skills}
        skillId={skillId}
        onSkillChange={onSkillChange}
        hasProviders={hasProviders}
        busy={busy}
        onSend={onSend}
      />
    </div>
  );
}
