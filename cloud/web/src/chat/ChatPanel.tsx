import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, KeyRound, Loader2, Sparkles } from 'lucide-react';
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
          <motion.div
            className="flex h-full items-center justify-center text-center text-ink-400"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
          >
            <div>
              <div className="accent-grad mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl text-ink-950 shadow-xl shadow-accent-700/30">
                <Sparkles size={26} />
              </div>
              <p className="text-lg font-semibold text-ink-100">Start a conversation</p>
              <p className="mt-1 text-sm">
                Cascade routes your prompt through its T1/T2/T3 orchestration and streams the result here.
              </p>
            </div>
          </motion.div>
        )}
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          <AnimatePresence initial={false}>
            {messages.map((m) => (
              <motion.div
                key={m.id}
                layout="position"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ type: 'spring', stiffness: 420, damping: 34 }}
              >
                <Message message={m} onRegenerate={m.id === lastAssistantId ? onRegenerate : undefined} />
              </motion.div>
            ))}
          </AnimatePresence>
          {status && busy && (
            <motion.div
              className="flex items-center gap-2 text-sm text-ink-400"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
            >
              <Loader2 size={14} className="animate-spin text-accent-500" />
              <span className="shimmer-text">{status}</span>
            </motion.div>
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
