import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, KeyRound, Loader2, Sparkles, Layers, ChevronDown, Search } from 'lucide-react';
import Message from './Message.js';
import Composer from './Composer.js';
import PlanNotice from './PlanNotice.js';
import ActivityDrawer from './ActivityDrawer.js';
import type { ActivityNode, ChatMessage, ForceTier, PlanApproval, RoutingMode, SendInput } from './useChatSession.js';
import type { Skill } from '../lib/types.js';
import type { UiMode } from '../lib/prefs.js';

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
  onStop: () => void;
  onRegenerate: () => void;
  routingMode: RoutingMode;
  onRoutingModeChange: (m: RoutingMode) => void;
  forceTier: ForceTier;
  onForceTierChange: (t: ForceTier) => void;
  webSearch: boolean;
  onWebSearchChange: (on: boolean) => void;
  uiMode: UiMode;
  approval: PlanApproval | null;
  compactionNotice: string | null;
  knowledgeNotice: string | null;
  activity: ActivityNode[];
}

export default function ChatPanel({
  messages, busy, error, status, hasProviders, skills, skillId, onSkillChange, onSend, onStop, onRegenerate,
  routingMode, onRoutingModeChange, forceTier, onForceTierChange, webSearch, onWebSearchChange, uiMode, approval,
  compactionNotice, knowledgeNotice, activity,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [activityOpen, setActivityOpen] = useState(false);
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
              <div className="accent-grad mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl text-white shadow-xl shadow-accent-700/30">
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
          {/* Read-only boardroom plan — Advanced view only (Simple stays minimal). */}
          {busy && approval && uiMode === 'advanced' && <PlanNotice approval={approval} />}
          {compactionNotice && (
            <motion.div
              className="flex items-center gap-2 rounded-lg border border-accent-500/20 bg-accent-500/[0.06] px-3 py-2 text-xs text-ink-300"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <Layers size={13} className="text-accent-300" />
              <span>{compactionNotice}</span>
            </motion.div>
          )}
          {knowledgeNotice && (
            <motion.div
              className="flex items-center gap-2 rounded-lg border border-accent-500/20 bg-accent-500/[0.06] px-3 py-2 text-xs text-ink-300"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <Search size={13} className="text-accent-300" />
              <span>{knowledgeNotice}</span>
            </motion.div>
          )}
          {status && busy && (
            <motion.div
              className="flex flex-col gap-2"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
            >
              <button
                type="button"
                onClick={() => activity.length > 0 && setActivityOpen((o) => !o)}
                disabled={activity.length === 0}
                className={`group flex items-center gap-2 self-start text-sm text-ink-400 ${activity.length > 0 ? 'cursor-pointer hover:text-ink-200' : 'cursor-default'}`}
                aria-expanded={activityOpen}
              >
                <Loader2 size={14} className="animate-spin text-accent-500" />
                <span className="shimmer-text">{status}</span>
                {activity.length > 0 && (
                  <ChevronDown
                    size={13}
                    className={`text-ink-500 transition-transform group-hover:text-ink-300 ${activityOpen ? 'rotate-180' : ''}`}
                  />
                )}
              </button>
              <AnimatePresence initial={false}>
                {activityOpen && activity.length > 0 && <ActivityDrawer activity={activity} />}
              </AnimatePresence>
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
        onStop={onStop}
        routingMode={routingMode}
        onRoutingModeChange={onRoutingModeChange}
        forceTier={forceTier}
        onForceTierChange={onForceTierChange}
        webSearch={webSearch}
        onWebSearchChange={onWebSearchChange}
        uiMode={uiMode}
      />
    </div>
  );
}
