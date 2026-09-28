import { useEffect, useRef, useState } from 'react';
import type { BrowserAllowanceView } from './browserAllowance.js';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, KeyRound, Layers, ChevronDown, Search, BookOpen, Calendar, Globe, Github } from 'lucide-react';
import CascadeMark from '../components/CascadeMark.js';
import Message from './Message.js';
import Composer from './Composer.js';
import PlanNotice from './PlanNotice.js';
import ActivityDrawer from './ActivityDrawer.js';
import { ReviewCard } from './ReviewCard.js';
import type { ActivityNode, ChatMessage, ForceTier, PlanApproval, RoutingMode, SendInput , ReviewSummary} from './useChatSession.js';
import type { Skill } from '../lib/types.js';
import { useMediaQuery } from '../lib/useMediaQuery.js';
import { BrowserLiveView } from './BrowserLiveView.js';
import type { BrowserInputEvent } from './BrowserLiveView.js';
import { ToolApprovalPrompt } from './ToolApprovalPrompt.js';
import { ClarificationPrompt } from './ClarificationPrompt.js';
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
  clarifications: import('./useChatSession.js').ClarificationRequest[];
  onAnswerClarification: (requestId: string, answers: import('./useChatSession.js').ClarificationAnswer[]) => void;
  browserMode: boolean;
  onBrowserModeChange: (on: boolean) => void;
  /** False on a deployment with no hosted browser: the chip is absent, not inert. */
  browserAvailable: boolean;
  onWebSearchChange: (on: boolean) => void;
  /** Show the plan and the agent tree while a run works (Settings → Appearance). */
  runDetail: boolean;
  /** First name for the empty state's greeting. */
  userName?: string;
  /** Size of this chat against the model's window, for the "filling up" note. */
  contextTokens?: number;
  contextWindow?: number;
  onAddKey?: () => void;
  onManageSkills?: () => void;
  onManageConnectors?: () => void;
  /** Open /why on one reply (the top bar's saved figure asks for the latest). */
  whyRequest?: { messageId: string; seq: number } | null;
  approval: PlanApproval | null;
  compactionNotice: string | null;
  providerNotice: string | null;
  knowledgeNotice: string | null;
  /** This run was refused the browser: every session was in use, or today's were spent. */
  browserRefusedNotice?: string | null;
  /** Today's browser sessions against the plan's allowance, when the server reports it. */
  browserAllowance?: BrowserAllowanceView;
  activity: ActivityNode[];
  /** Where the agent's browser can be watched, while it has one. */
  browserLiveView?: string | undefined;
  /** A browser is attached, whether or not the provider can stream it. */
  browserActive?: boolean;
  /** The newest frame of that browser, streamed by the page itself over CDP. */
  browserFrame?: { data: string; width: number; height: number; generation?: number } | undefined;
  /** Which run's browser the panel is showing. Its view identity, not a label. */
  browserTaskId?: string | undefined;
  /** The server confirmed the stream started, so an empty panel is worth explaining. */
  browserStreaming?: boolean;
  /** The user, not the agent, is driving that browser right now. */
  browserHuman?: boolean;
  /** Whether it is still being pictured while they drive it. */
  browserCapturing?: boolean;
  browserConfirmed?: boolean;
  /** Something the browser refused to do for this conversation. */
  browserNotice?: string | undefined;
  /** Ask for the browser, and give it back. */
  onTakeOverBrowser?: () => void;
  onHandBackBrowser?: () => void;
  /** One thing the user did to the page while holding it. */
  onBrowserInput?: (event: BrowserInputEvent) => void;
  /** Pause or resume the picture without giving the page back. */
  onBrowserCapture?: (on: boolean) => void;
  onBrowserFrameShown?: (taskId: string, generation: number) => void;
  /** Dangerous tool calls waiting on the user. */
  toolApprovals?: ToolApproval[];
  onDecideToolApproval?: (requestId: string, approved: boolean, always?: boolean) => void;
  /** Withdraw the browser from the run, without stopping the run itself. */
  onStopBrowser?: () => void;
}

export default function ChatPanel({
  messages, busy, error, status, hasProviders, skills, skillId, onSkillChange, onSend, onStop, onRegenerate,
  onEditMessage, onDeleteMessage, onSelectSibling,
  routingMode, onRoutingModeChange, forceTier, onForceTierChange, webSearch, onWebSearchChange,
  clarifications, onAnswerClarification,
  browserMode, onBrowserModeChange, browserAvailable, runDetail, userName, contextTokens = 0, contextWindow = 0,
  onAddKey, onManageSkills, onManageConnectors, whyRequest, approval,
  compactionNotice, providerNotice, knowledgeNotice, browserRefusedNotice, browserAllowance, activity, browserLiveView, browserActive,
  browserFrame, browserTaskId, browserStreaming, browserHuman, browserCapturing, browserConfirmed, browserNotice,
  onStopBrowser, onTakeOverBrowser, onHandBackBrowser, onBrowserInput, onBrowserCapture,
  onBrowserFrameShown,
  toolApprovals, onDecideToolApproval,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const [draftRequest, setDraftRequest] = useState<{ text: string; seq: number } | null>(null);
  // The browser gets a pane of its own where there is room for one beside the
  // thread; on a narrower screen it stays above the composer, so its Stop
  // control is never scrolled away with the messages.
  const wide = useMediaQuery('(min-width: 1024px)');

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

  const empty = messages.length === 0 && !busy;
  const ctxWindow = contextWindow > 0 ? contextWindow : 128_000;
  const ctxFull = contextTokens > 0 && contextTokens / ctxWindow >= 0.85;

  const suggestions: Array<{ label: string; prompt: string; icon: React.ReactNode; browser?: boolean }> = [
    { label: 'Research a topic', prompt: 'Build a competitor report on AI coding CLIs and export it as a Word doc', icon: <BookOpen size={14} /> },
    { label: 'Plan something', prompt: 'Plan a team offsite', icon: <Calendar size={14} /> },
    ...(browserAvailable ? [{ label: 'Check a live page', prompt: 'Open example.com/pricing and tell me the Team plan price with annual billing', icon: <Globe size={14} />, browser: true }] : []),
    { label: 'Summarise repos', prompt: 'Summarise every repository in our GitHub org', icon: <Github size={14} /> },
  ];

  const browserView = (
    <BrowserLiveView
      key={browserTaskId ?? 'no-browser-task'}
      active={browserActive === true}
      liveViewUrl={browserLiveView}
      frame={browserFrame}
      taskId={browserTaskId}
      streaming={browserStreaming}
      human={browserHuman}
      capturing={browserCapturing}
      confirmed={browserConfirmed}
      notice={browserNotice}
      onStop={() => onStopBrowser?.()}
      onTakeOver={() => onTakeOverBrowser?.()}
      onHandBack={() => onHandBackBrowser?.()}
      onInput={(e) => onBrowserInput?.(e)}
      onCapture={(on) => onBrowserCapture?.(on)}
      onFrameShown={(g) => { if (browserTaskId) onBrowserFrameShown?.(browserTaskId, g); }}
    />
  );
  const paneOpen = wide && browserActive === true;

  const note = 'flex items-center gap-2 text-[12.5px] text-ink-300';

  return (
    <div className="flex h-full min-h-0">
      <div className={`relative flex min-w-0 flex-1 flex-col ${empty ? 'justify-center' : ''}`}>
        <div className={empty ? 'flex-none px-5 pb-[18px] pt-2.5' : 'min-h-0 flex-1 overflow-y-auto px-5 pb-7 pt-3'}>
          {empty ? (
            <motion.div
              className="flex flex-col items-center gap-3.5 text-center"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
            >
              <CascadeMark size={40} animate={false} />
              <h1 className="m-0 font-serif text-[clamp(28px,4.2vw,38px)] font-normal tracking-[-0.015em] text-ink-50">
                {greeting()}{userName ? `, ${userName}` : ''}
              </h1>
            </motion.div>
          ) : (
            <div className="mx-auto flex max-w-[720px] flex-col gap-[26px]">
              <AnimatePresence initial={false}>
                {messages.map((m) => (
                  <motion.div
                    key={m.id}
                    layout="position"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.25, ease: 'easeOut' }}
                  >
                    <Message
                      message={m}
                      busy={busy}
                      whyRequest={whyRequest?.messageId === m.id ? whyRequest.seq : undefined}
                      onRegenerate={m.role === 'assistant' && !m.streaming ? () => onRegenerate(m.id) : undefined}
                      onEdit={m.role === 'user' ? (text) => onEditMessage(m.id, text) : undefined}
                      onDelete={!m.streaming ? () => onDeleteMessage(m.id) : undefined}
                      onSelectSibling={onSelectSibling}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
              {compactionNotice && (
                <div className={note}><Layers size={14} className="shrink-0 text-ink-500" /><span>{compactionNotice}</span></div>
              )}
              {providerNotice && (
                <div className={note}><AlertTriangle size={14} className="shrink-0 text-warning-500" /><span>{providerNotice}</span></div>
              )}
              {browserRefusedNotice && (
                <div role="status" className={note}><AlertTriangle size={14} className="shrink-0 text-warning-500" /><span>{browserRefusedNotice}</span></div>
              )}
              {knowledgeNotice && (
                <div className={note}><Search size={14} className="shrink-0 text-ink-500" /><span>{knowledgeNotice}</span></div>
              )}
              {status && busy && (
                <motion.div className="grid grid-cols-[3px_1fr] gap-4" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
                  {/* The spine: the brand ramp flowing down beside live work. */}
                  <div className="cascade-spine rounded-full" aria-hidden="true" />
                  <div className="flex min-w-0 flex-col gap-2.5">
                    <button
                      type="button"
                      onClick={() => !runDetail && activity.length > 0 && setActivityOpen((o) => !o)}
                      disabled={runDetail || activity.length === 0}
                      className={`group flex items-center gap-[9px] self-start text-[14px] text-ink-300 ${!runDetail && activity.length > 0 ? 'cursor-pointer hover:text-ink-50' : 'cursor-default'}`}
                      aria-expanded={runDetail ? undefined : activityOpen}
                    >
                      <CascadeMark size={18} />
                      <span className="shimmer-text">{status}</span>
                      {!runDetail && activity.length > 0 && (
                        <ChevronDown size={13} className={`text-ink-500 transition-transform group-hover:text-ink-300 ${activityOpen ? 'rotate-180' : ''}`} />
                      )}
                    </button>
                    {runDetail && approval && <PlanNotice approval={approval} />}
                    <AnimatePresence initial={false}>
                      {(runDetail || activityOpen) && activity.length > 0 && <ActivityDrawer activity={activity} />}
                    </AnimatePresence>
                    {/* A rejected review is shown WITHOUT waiting for the tree to be
                        opened: it explains why the run is repeating itself, which is
                        the one thing a user watching a replan actually needs. */}
                    <AnimatePresence initial={false}>
                      {latestReview && <ReviewCard review={latestReview} />}
                    </AnimatePresence>
                  </div>
                </motion.div>
              )}
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="flex shrink-0 flex-col gap-2.5 px-5 pb-4 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[720px]" style={empty ? { paddingBottom: '12vh' } : undefined}>
          {error && (
            <div className="flex items-center gap-2 rounded-xl bg-danger-500/[0.08] px-3 py-2 text-[13px] text-danger-300">
              <AlertTriangle size={14} className="shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {/* The run is BLOCKED on these, so they sit right above the composer. */}
          <div className="flex max-h-[48vh] flex-col gap-2 overflow-y-auto empty:hidden">
            <ClarificationPrompt clarifications={clarifications} onAnswer={onAnswerClarification} />
            <ToolApprovalPrompt
              approvals={toolApprovals ?? []}
              onDecide={(id, ok, always) => onDecideToolApproval?.(id, ok, always)}
            />
          </div>
          {!paneOpen && browserActive && <div>{browserView}</div>}
          {!hasProviders && (
            <div className={note}>
              <KeyRound size={14} className="shrink-0 text-ink-500" />
              <span className="flex-1">Add a provider key before starting a chat.</span>
              {onAddKey && <button type="button" onClick={onAddKey} className="cz-btn cz-btn-ghost cz-btn-sm">Add a key</button>}
            </div>
          )}
          {ctxFull && (
            <div className={note}>
              <AlertTriangle size={14} className="shrink-0 text-warning-500" />
              <span>This chat is filling the model's window — start a new chat to keep replies sharp.</span>
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
            browserMode={browserMode}
            onBrowserModeChange={onBrowserModeChange}
            browserAvailable={browserAvailable}
            browserAllowance={browserAllowance ?? null}
            onWebSearchChange={onWebSearchChange}
            onManageSkills={onManageSkills}
            onManageConnectors={onManageConnectors}
            draftRequest={draftRequest}
          />
          {empty && (
            <div className="flex flex-wrap justify-center gap-2">
              {suggestions.map((sg) => (
                <button
                  key={sg.label}
                  type="button"
                  className="cz-chip"
                  onClick={() => {
                    if (sg.browser) onBrowserModeChange(true);
                    setDraftRequest({ text: sg.prompt, seq: Date.now() });
                  }}
                >
                  {sg.icon} {sg.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {paneOpen && (
        <aside aria-label="Browser" className="z-[18] flex w-[min(480px,44%)] shrink-0 flex-col border-l border-elev/10 bg-side">
          <div className="min-h-0 flex-1 overflow-y-auto p-[18px]">{browserView}</div>
        </aside>
      )}
    </div>
  );
}

function greeting(now = new Date()): string {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
