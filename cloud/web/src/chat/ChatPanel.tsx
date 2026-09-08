import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, KeyRound, Sparkles, Layers, ChevronDown, Search } from 'lucide-react';
import CascadeMark from '../components/CascadeMark.js';
import Message from './Message.js';
import Composer from './Composer.js';
import PlanNotice from './PlanNotice.js';
import ActivityDrawer from './ActivityDrawer.js';
import { ReviewCard } from './ReviewCard.js';
import type { ActivityNode, ChatMessage, ForceTier, PlanApproval, RoutingMode, SendInput , ReviewSummary} from './useChatSession.js';
import type { Skill } from '../lib/types.js';
import type { UiMode } from '../lib/prefs.js';
import { BrowserLiveView } from './BrowserLiveView.js';
import { ToolApprovalPrompt } from './ToolApprovalPrompt.js';
import type { ToolApproval } from './useChatSession.js';

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
  onRegenerate: (assistantId?: string) => void;
  /** Branching: edit a user turn (forks a new branch and re-runs). */
  onEditMessage: (messageId: string, newText: string) => void;
  /** Branching: delete a message and its whole subtree. */
  onDeleteMessage: (messageId: string) => void;
  /** Branching: switch the active path to a sibling (the < n/m > arrows). */
  onSelectSibling: (messageId: string) => void;
  routingMode: RoutingMode;
  onRoutingModeChange: (m: RoutingMode) => void;
  forceTier: ForceTier;
  onForceTierChange: (t: ForceTier) => void;
  webSearch: boolean;
  onWebSearchChange: (on: boolean) => void;
  uiMode: UiMode;
  approval: PlanApproval | null;
  compactionNotice: string | null;
  providerNotice: string | null;
  knowledgeNotice: string | null;
  activity: ActivityNode[];
  /** Where the agent's browser can be watched, while it has one. */
  browserLiveView?: string | undefined;
  /** A browser is attached, whether or not the provider can stream it. */
  browserActive?: boolean;
  /** Dangerous tool calls waiting on the user. */
  toolApprovals?: ToolApproval[];
  onDecideToolApproval?: (requestId: string, approved: boolean, always?: boolean) => void;
  /** Withdraw the browser from the run, without stopping the run itself. */
  onStopBrowser?: () => void;
}

export default function ChatPanel({
  messages, busy, error, status, hasProviders, skills, skillId, onSkillChange, onSend, onStop, onRegenerate,
  onEditMessage, onDeleteMessage, onSelectSibling,
  routingMode, onRoutingModeChange, forceTier, onForceTierChange, webSearch, onWebSearchChange, uiMode, approval,
  compactionNotice, providerNotice, knowledgeNotice, activity, browserLiveView, browserActive, onStopBrowser, toolApprovals, onDecideToolApproval,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [activityOpen, setActivityOpen] = useState(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, status]);

  // The most recent verdict across the live tiers. Reviews come from T1, so
  // there is at most one in flight; scanning the whole list rather than
  // assuming a position keeps this correct if that ever stops being true.
  const latestReview = activity.reduce<ReviewSummary | undefined>(
    (found, node) => node.review ?? found,
    undefined,
  );

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
                <Message
                  message={m}
                  busy={busy}
                  onRegenerate={m.role === 'assistant' && !m.streaming ? () => onRegenerate(m.id) : undefined}
                  onEdit={m.role === 'user' ? (text) => onEditMessage(m.id, text) : undefined}
                  onDelete={!m.streaming ? () => onDeleteMessage(m.id) : undefined}
                  onSelectSibling={onSelectSibling}
                />
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
          {providerNotice && (
            <motion.div
              className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2 text-xs text-ink-200"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <AlertTriangle size={13} className="text-amber-300" />
              <span>{providerNotice}</span>
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
                <CascadeMark size={15} />
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
              {/* A rejected review is shown WITHOUT waiting for the drawer to be
                  opened: it explains why the run is repeating itself, which is
                  the one thing a user watching a replan actually needs. */}
              <AnimatePresence initial={false}>
                {latestReview && <ReviewCard review={latestReview} />}
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

      {/* Above the composer, not inside the transcript: the browser is live for
          as long as the run holds it, and a panel that scrolled away with the
          messages would take the Stop control off screen exactly when the user
          wanted it. */}
      {/* Above the browser panel: the run is BLOCKED on this, so it is the
          most urgent thing on screen. */}
      <div className="mx-4 sm:mx-6">
        <ToolApprovalPrompt
          approvals={toolApprovals ?? []}
          onDecide={(id, ok, always) => onDecideToolApproval?.(id, ok, always)}
        />
      </div>

      <div className="mx-4 sm:mx-6">
        <BrowserLiveView active={browserActive === true} liveViewUrl={browserLiveView} onStop={() => onStopBrowser?.()} />
      </div>

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
