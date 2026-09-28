import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { AnimatePresence, MotionConfig, motion } from 'framer-motion';
import LandingPage from './components/LandingPage.js';
import Modal from './components/Modal.js';
import UpgradeModal from './components/UpgradeModal.js';
import MemoryModal from './components/MemoryModal.js';
import ConnectorsModal from './components/ConnectorsModal.js';
import FilesPanel from './components/FilesPanel.js';
import SkillsModal from './components/SkillsModal.js';
import SettingsModal from './components/SettingsModal.js';
import ConversationSidebar from './chat/ConversationSidebar.js';
import ChatPanel from './chat/ChatPanel.js';
import ChatTopBar from './chat/ChatTopBar.js';
import ContinueModal from './chat/ContinueModal.js';
import EscalationModal from './chat/EscalationModal.js';
import ContextApprovalDialog from './chat/ContextApprovalDialog.js';
import KeyVault from './keys/KeyVault.js';
import Toaster from './components/Toaster.js';
import { toast } from './lib/toast.js';
import { useMediaQuery } from './lib/useMediaQuery.js';
import { useChatSession, toChatMessage } from './chat/useChatSession.js';
import { useAutoTitler } from './chat/useAutoTitler.js';
import { useBrowserAllowance } from './chat/browserAllowance.js';
import { loadKeys, saveKeys, takeRetiredProviderNotice } from './keys/store.js';
import { loadWebSearch, saveWebSearch, webSearchPayload } from './keys/webSearch.js';
import {
  localModelEnabled, reduceMotionEnabled,
  themeMode, setThemeMode, density, setDensity, runDetail, setRunDetail,
  type ThemeMode, type Density,
} from './lib/prefs.js';
import { initTheme, applyTheme, applyDensity } from './lib/theme.js';
import {
  deleteConversation, fetchConfig, fetchMe, fetchSkills, getMessages, listConversations, logout, renameConversation,
  type CloudConfig,
} from './lib/api.js';
import { closeSocket, getSocket } from './lib/socket.js';
import type { CloudConversation, CloudUser, ProviderConfig, Skill } from './lib/types.js';

const SIDEBAR_OPEN_KEY = 'cascade-cloud-sidebar-open';
const DEFAULT_SKILL = 'general';

export default function App() {
  const [config, setConfig] = useState<CloudConfig | null>(null);
  const [user, setUser] = useState<CloudUser | null | undefined>(undefined);
  const [conversations, setConversations] = useState<CloudConversation[]>([]);
  const [providers, setProviders] = useState<ProviderConfig[]>(() => loadKeys());
  // loadKeys() migrates retired provider types out of the vault as a side
  // effect. Read the notice in the same initializer pass so it is captured
  // before any re-render clears it — a key vanishing without explanation
  // looks like data loss, and the alternative (finding out via a failed run)
  // is worse.
  const [retiredNotice, setRetiredNotice] = useState<string | null>(() => takeRetiredProviderNotice());
  const [webSearch, setWebSearch] = useState(() => loadWebSearch());
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillId, setSkillId] = useState<string>(DEFAULT_SKILL);
  const [showVault, setShowVault] = useState(false);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [showConnectors, setShowConnectors] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showContinue, setShowContinue] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(() => reduceMotionEnabled());
  const [theme, setTheme] = useState<ThemeMode>(() => themeMode());
  const [densityMode, setDensityMode] = useState<Density>(() => density());
  const [detail, setDetail] = useState(() => runDetail());
  // One sidebar, in whichever container fits: flush beside the chat on a
  // desktop, a drawer over it on a phone. Mounting both copies (one hidden by
  // CSS) would duplicate its search box and account menu.
  const desktop = useMediaQuery('(min-width: 768px)');
  // Bumped to open the sidebar's chat search (⌘K / Ctrl+K), and to open /why
  // on a reply from the top bar's saved figure.
  const [searchRequest, setSearchRequest] = useState(0);
  const [whyRequest, setWhyRequest] = useState<{ messageId: string; seq: number } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    const stored = localStorage.getItem(SIDEBAR_OPEN_KEY);
    // No explicit preference yet: default open on desktop (today's always-visible
    // sidebar), closed on narrow viewports (a drawer covering the whole screen
    // on first mobile visit is a worse default than starting collapsed).
    return stored !== null ? stored !== '0' : window.innerWidth >= 768;
  });

  // Apply the stored theme + density on mount and follow the OS while in
  // "system" mode (initTheme returns the listener-cleanup).
  useEffect(() => initTheme(), []);

  function changeTheme(m: ThemeMode) { setTheme(m); setThemeMode(m); applyTheme(m); }
  function changeDensity(d: Density) { setDensityMode(d); setDensity(d); applyDensity(d); }
  function changeDetail(on: boolean) { setDetail(on); setRunDetail(on); }

  function setSidebar(next: boolean) {
    setSidebarOpen(next);
    try { localStorage.setItem(SIDEBAR_OPEN_KEY, next ? '1' : '0'); } catch { /* storage unavailable */ }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSidebar(true);
        setSearchRequest((n) => n + 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const refreshSkills = useCallback(() => {
    fetchSkills().then((r) => setSkills(r.skills)).catch(() => setSkills([]));
  }, []);

  useEffect(() => {
    fetchConfig()
      .then(setConfig)
      .catch(() => setConfig({ githubEnabled: false, googleEnabled: false, googleClientId: null, devLoginEnabled: false }));
    refreshSkills();
  }, [refreshSkills]);

  const refreshMe = useCallback(() => {
    fetchMe().then((r) => setUser(r.user)).catch(() => setUser(null));
  }, []);

  useEffect(() => { refreshMe(); }, [refreshMe]);

  const refreshConversations = useCallback(() => {
    listConversations().then((r) => setConversations(r.conversations)).catch(() => {});
  }, []);

  useEffect(() => {
    if (user) refreshConversations();
  }, [user, refreshConversations]);

  // Re-fetch once logged in so the user's own custom skills join the built-ins
  // (the pre-login fetch only sees the public catalog).
  useEffect(() => {
    if (user) refreshSkills();
  }, [user, refreshSkills]);

  const socket = user ? getSocket() : null;
  // Routing, web and browser are always a menu away now (there is no Simple
  // view that hides them), so the controls are always visible to the session.
  const chat = useChatSession(socket, providers, skillId, webSearchPayload(webSearch), undefined, true);
  // Re-read as each run starts and ends, which is when a session can be spent.
  const browserAllowance = useBrowserAllowance(user?.id, config?.remoteBrowserEnabled === true, chat.busy, chat.browserMode, chat.setBrowserMode);
  const [localModelOn, setLocalModelOn] = useState(() => localModelEnabled());

  // A run may have created a new conversation or renamed one — refresh the
  // sidebar once the run settles (covers the initial idle mount too, which
  // is a harmless extra fetch).
  useEffect(() => {
    if (user && !chat.busy) refreshConversations();
  }, [user, chat.busy, refreshConversations]);

  // Opt-in on-device auto-titling: when idle, name the current conversation.
  useAutoTitler({
    enabled: localModelOn,
    conversationId: chat.conversationId,
    messages: chat.messages,
    busy: chat.busy,
    onTitled: refreshConversations,
  });

  // Reflect the reduce-motion preference on the document so CSS can honor it.
  useEffect(() => {
    document.documentElement.dataset['reduceMotion'] = reduceMotion ? '1' : '0';
  }, [reduceMotion]);

  function updateProviders(next: ProviderConfig[]) {
    setProviders(next);
    saveKeys(next);
  }

  function updateWebSearch(next: import('./lib/types.js').WebSearchSettings | null) {
    setWebSearch(next);
    saveWebSearch(next);
  }

  async function selectConversation(id: string) {
    const { conversation, messages } = await getMessages(id);
    chat.setConversationId(id);
    if (conversation?.skillId) setSkillId(conversation.skillId);
    chat.loadMessages(messages.map(toChatMessage));
  }

  function newChat() {
    chat.setConversationId(undefined);
    chat.loadMessages([]);
  }

  // A code redeemed in the Continue modal seeded a new cloud conversation —
  // refresh the sidebar and open it so the user keeps going right where the
  // other device left off.
  async function handleRedeemed(conversationId: string) {
    setShowContinue(false);
    refreshConversations();
    await selectConversation(conversationId);
  }

  async function handleLogout() {
    await logout();
    closeSocket();
    setUser(null);
    setConversations([]);
  }

  if (user === undefined || config === null) {
    return (
      <div className="flex h-dvh items-center justify-center text-ink-400">
        <motion.span
          className="shimmer-text text-sm font-medium"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
        >
          Loading Cascade…
        </motion.span>
      </div>
    );
  }

  if (!user) {
    return <LandingPage config={config} onDevLogin={refreshMe} />;
  }

  const activeTitle = conversations.find((c) => c.id === chat.conversationId)?.title ?? undefined;
  // What delegation saved across this chat, from each reply's stored /why
  // report — so the figure is the same after a reload, or on another day.
  const savedUsd = chat.messages.reduce((sum, m) => sum + (!m.streaming && (m.why?.savedUsd ?? 0) > 0 ? m.why!.savedUsd : 0), 0);
  const lastWithWhy = [...chat.messages].reverse().find((m) => m.role === 'assistant' && !m.streaming && m.why);
  const narrow = () => !desktop;

  function removedConversation(id: string) {
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (chat.conversationId === id) newChat();
    refreshConversations();
  }

  async function deleteActive() {
    const id = chat.conversationId;
    if (!id) return;
    try { await deleteConversation(id); removedConversation(id); } catch { toast('Could not delete that chat.'); }
  }

  async function renameActive(title: string) {
    const id = chat.conversationId;
    if (!id) return;
    try {
      await renameConversation(id, title);
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
    } catch {
      toast('Could not rename that chat.');
    }
  }

  // The current transcript, shaped for a handoff (only settled user/assistant
  // turns — drop the in-flight streaming placeholder and any empty content).
  const continueTranscript = {
    title: activeTitle ?? null,
    skillId,
    messages: chat.messages
      .filter((m) => !m.streaming && m.content.trim())
      .map((m) => ({ role: m.role, content: m.content })),
  };

  const sidebar = (
    <ConversationSidebar
      user={user}
      conversations={conversations}
      activeConversationId={chat.conversationId}
      runningConversationId={chat.busy ? chat.conversationId : undefined}
      contextTokens={chat.contextTokens}
      contextWindow={chat.contextWindow}
      lastTokens={chat.lastTokens}
      usageRefreshSignal={chat.busy}
      searchRequest={searchRequest}
      onSelect={(id) => { void selectConversation(id); if (narrow()) setSidebarOpen(false); }}
      onNewChat={() => { newChat(); if (narrow()) setSidebarOpen(false); }}
      onClose={() => setSidebar(false)}
      onOpenSettings={() => setShowSettings(true)}
      onOpenFiles={() => { setShowFiles(true); if (narrow()) setSidebarOpen(false); }}
      onOpenSkills={() => setShowSkills(true)}
      onOpenMemory={() => setShowMemory(true)}
      onOpenConnectors={() => setShowConnectors(true)}
      onOpenKeys={() => setShowVault(true)}
      onOpenContinue={() => setShowContinue(true)}
      onOpenUpgrade={() => setShowUpgrade(true)}
      onLogout={() => void handleLogout()}
      onDeleted={removedConversation}
      onImported={refreshConversations}
    />
  );

  return (
    <MotionConfig reducedMotion={reduceMotion ? 'always' : 'user'}>
    <div className="relative flex h-dvh gap-0 overflow-hidden">
      {retiredNotice && (
        <div
          role="status"
          className="glass absolute inset-x-3 top-3 z-50 flex items-start gap-3 rounded-xl px-4 py-3 text-sm text-ink-100"
        >
          <span className="flex-1">{retiredNotice}</span>
          <button
            type="button"
            className="shrink-0 rounded px-2 py-0.5 text-xs text-ink-400 hover:text-ink-100"
            onClick={() => setRetiredNotice(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Desktop: a flush sidebar that slides away */}
      {desktop && (
        <div
          className={clsx(
            'shrink-0 overflow-hidden transition-[width] duration-200 ease-out',
            sidebarOpen ? 'w-[260px]' : 'w-0',
          )}
        >
          <div className="h-full w-[260px] overflow-hidden border-r border-elev/10 bg-side">{sidebarOpen && sidebar}</div>
        </div>
      )}

      {/* Phone: the same sidebar over the chat, with a scrim */}
      <AnimatePresence>
        {!desktop && sidebarOpen && (
          <>
            <motion.div
              key="scrim"
              className="fixed inset-0 z-30 bg-black/30"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSidebarOpen(false)}
            />
            <motion.div
              key="drawer"
              className="fixed inset-y-0 left-0 z-40 w-[260px] overflow-hidden bg-side shadow-[var(--glass-shadow-strong)]"
              initial={{ x: '-105%' }}
              animate={{ x: 0 }}
              exit={{ x: '-105%' }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
            >
              {sidebar}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Main chat panel */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <ChatTopBar
          title={activeTitle}
          hasConversation={!!chat.conversationId}
          // On a phone the sidebar is an overlay, so the chat always needs a way to open it.
          sidebarOpen={sidebarOpen && desktop}
          onOpenSidebar={() => setSidebar(true)}
          savedUsd={savedUsd}
          onShowWhy={() => { if (lastWithWhy) setWhyRequest({ messageId: lastWithWhy.id, seq: Date.now() }); }}
          onRename={renameActive}
          onContinueElsewhere={() => setShowContinue(true)}
          onOpenFiles={() => setShowFiles(true)}
          onDeleteChat={() => void deleteActive()}
        />
        <div className="min-h-0 flex-1">
          <ChatPanel
            messages={chat.messages}
            busy={chat.busy}
            error={chat.error}
            status={chat.status}
            hasProviders={providers.length > 0}
            skills={skills}
            skillId={skillId}
            onSkillChange={setSkillId}
            onSend={chat.send}
            onStop={chat.stop}
            browserLiveView={chat.browserLiveView}
            browserActive={chat.browserActive}
            browserFrame={chat.browserFrame}
            browserTaskId={chat.browserTaskId}
            browserStreaming={chat.browserStreaming}
            browserHuman={chat.browserHuman}
            browserCapturing={chat.browserCapturing}
            browserConfirmed={chat.browserConfirmed}
            browserNotice={chat.browserNotice}
            onTakeOverBrowser={chat.takeOverBrowser}
            onHandBackBrowser={chat.handBackBrowser}
            onBrowserInput={chat.sendBrowserInput}
            onBrowserCapture={chat.setBrowserCapture}
            onBrowserFrameShown={chat.markBrowserFrameShown}
            toolApprovals={chat.toolApprovals}
            onDecideToolApproval={chat.resolveToolApproval}
            onStopBrowser={chat.stopBrowser}
            onRegenerate={chat.regenerate}
            onEditMessage={chat.editMessage}
            onDeleteMessage={chat.deleteMessage}
            onSelectSibling={chat.selectSibling}
            routingMode={chat.routingMode}
            onRoutingModeChange={chat.setRoutingMode}
            forceTier={chat.forceTier}
            onForceTierChange={chat.setForceTier}
            webSearch={chat.webSearch}
            onWebSearchChange={chat.setWebSearch}
            clarifications={chat.clarifications}
            onAnswerClarification={chat.answerClarification}
            browserMode={chat.browserMode}
            onBrowserModeChange={chat.setBrowserMode}
            browserAvailable={config?.remoteBrowserEnabled === true}
            runDetail={detail}
            userName={(user.name ?? '').trim().split(/\s+/)[0] || undefined}
            contextTokens={chat.contextTokens}
            contextWindow={chat.contextWindow}
            onAddKey={() => setShowVault(true)}
            onManageSkills={() => setShowSkills(true)}
            onManageConnectors={() => setShowConnectors(true)}
            whyRequest={whyRequest}
            approval={chat.approval}
            compactionNotice={chat.compactionNotice}
            providerNotice={chat.providerNotice}
            knowledgeNotice={chat.knowledgeNotice}
            browserRefusedNotice={chat.browserRefusedNotice}
            browserAllowance={browserAllowance}
            activity={chat.activity}
          />
        </div>
      </div>

      <AnimatePresence>
        {/* Settings renders FIRST so that a sub-modal opened from it (Skills,
            Memory, API keys…) paints ABOVE Settings' briefly-exiting backdrop
            instead of behind it — otherwise the exiting scrim eats clicks. */}
        {showSettings && (
          <SettingsModal
            user={user}
            onClose={() => setShowSettings(false)}
            onOpenSkills={() => setShowSkills(true)}
            onOpenMemory={() => setShowMemory(true)}
            onOpenConnectors={() => setShowConnectors(true)}
            onOpenKeyVault={() => setShowVault(true)}
            onOpenUpgrade={() => setShowUpgrade(true)}
            onLogout={handleLogout}
            onLocalModelChange={setLocalModelOn}
            onReduceMotionChange={setReduceMotion}
            theme={theme}
            onThemeChange={changeTheme}
            density={densityMode}
            onDensityChange={changeDensity}
            runDetail={detail}
            onRunDetailChange={changeDetail}
            onChatsCleared={() => { setConversations([]); newChat(); refreshConversations(); }}
          />
        )}
        {/* A parked run waiting on a decision. Rendered ahead of the other
            modals because the run is blocked until it is answered — everything
            else can wait, this cannot. */}
        {chat.escalations.length > 0 && (
          <EscalationModal
            requests={chat.escalations}
            onResolve={chat.resolveEscalation}
            // Dismissing is 'skip', not silence: the run is parked, so closing
            // the window without an answer would leave it waiting out the full
            // timeout and then failing the section for no reason. Applied to
            // every section in the window, because that reasoning is about each
            // of them rather than about whichever was on top.
            onDismiss={chat.skipAllEscalations}
            // The countdown running out is not a decision — the server already
            // failed the section, so only clear that prompt.
            onExpire={chat.clearEscalation}
          />
        )}
        {showVault && (
          <Modal title="API keys" onClose={() => setShowVault(false)}>
            <KeyVault
              keys={providers}
              onChange={updateProviders}
              webSearch={webSearch}
              onWebSearchChange={updateWebSearch}
              syncEnabled={!!user}
            />
          </Modal>
        )}
        {showUpgrade && (
          <Modal title="Upgrade" onClose={() => setShowUpgrade(false)} maxWidth="max-w-lg">
            <UpgradeModal />
          </Modal>
        )}
        {showMemory && <MemoryModal onClose={() => setShowMemory(false)} />}
        {showConnectors && <ConnectorsModal onClose={() => setShowConnectors(false)} />}
        {showFiles && <FilesPanel onClose={() => setShowFiles(false)} onUpgrade={() => { setShowFiles(false); setShowUpgrade(true); }} />}
        {showSkills && (
          <SkillsModal
            skills={skills}
            onClose={() => setShowSkills(false)}
            onChange={refreshSkills}
            activeSkillId={skillId}
            onUse={setSkillId}
          />
        )}
        {showContinue && (
          <ContinueModal
            transcript={continueTranscript}
            onClose={() => setShowContinue(false)}
            onRedeemed={handleRedeemed}
          />
        )}
        {chat.contextApprovals.length > 0 && (
          <ContextApprovalDialog infos={chat.contextApprovals} onResolve={chat.resolveContextApproval} />
        )}
      </AnimatePresence>
      <Toaster />
    </div>
    </MotionConfig>
  );
}
