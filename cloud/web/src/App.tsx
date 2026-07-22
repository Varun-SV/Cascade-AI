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
import ContextApprovalDialog from './chat/ContextApprovalDialog.js';
import KeyVault from './keys/KeyVault.js';
import { useChatSession, toChatMessage } from './chat/useChatSession.js';
import { useAutoTitler } from './chat/useAutoTitler.js';
import { loadKeys, saveKeys } from './keys/store.js';
import { loadWebSearch, saveWebSearch, webSearchPayload } from './keys/webSearch.js';
import {
  localModelEnabled, reduceMotionEnabled,
  themeMode, setThemeMode, density, setDensity, uiMode, setUiMode,
  type ThemeMode, type Density, type UiMode,
} from './lib/prefs.js';
import { initTheme, applyTheme, applyDensity } from './lib/theme.js';
import { fetchConfig, fetchMe, fetchSkills, getMessages, listConversations, logout, type CloudConfig } from './lib/api.js';
import { closeSocket, getSocket } from './lib/socket.js';
import type { CloudConversation, CloudUser, ProviderConfig, Skill } from './lib/types.js';

const SIDEBAR_OPEN_KEY = 'cascade-cloud-sidebar-open';
const DEFAULT_SKILL = 'general';

export default function App() {
  const [config, setConfig] = useState<CloudConfig | null>(null);
  const [user, setUser] = useState<CloudUser | null | undefined>(undefined);
  const [conversations, setConversations] = useState<CloudConversation[]>([]);
  const [providers, setProviders] = useState<ProviderConfig[]>(() => loadKeys());
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
  const [mode, setMode] = useState<UiMode>(() => uiMode());
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
  function changeMode(m: UiMode) { setMode(m); setUiMode(m); }

  function toggleSidebar() {
    setSidebarOpen((open) => {
      const next = !open;
      localStorage.setItem(SIDEBAR_OPEN_KEY, next ? '1' : '0');
      return next;
    });
  }

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
  const chat = useChatSession(socket, providers, skillId, webSearchPayload(webSearch));
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
      contextTokens={chat.contextTokens}
      contextWindow={chat.contextWindow}
      lastTokens={chat.lastTokens}
      usageRefreshSignal={chat.busy}
      onSelect={(id) => { void selectConversation(id); if (window.innerWidth < 768) setSidebarOpen(false); }}
      onNewChat={() => { newChat(); if (window.innerWidth < 768) setSidebarOpen(false); }}
      onOpenSettings={() => setShowSettings(true)}
      onDeleted={(id) => { setConversations((prev) => prev.filter((c) => c.id !== id)); if (chat.conversationId === id) newChat(); refreshConversations(); }}
      onImported={refreshConversations}
    />
  );

  return (
    <MotionConfig reducedMotion={reduceMotion ? 'always' : 'user'}>
    <div className="relative flex h-dvh gap-0 overflow-hidden md:gap-3 md:p-3">
      {/* Desktop: collapsible floating glass panel */}
      <div
        className={clsx(
          'hidden shrink-0 overflow-hidden transition-[width,opacity] duration-300 ease-out md:block',
          sidebarOpen ? 'w-72 opacity-100' : 'w-0 opacity-0',
        )}
      >
        <div className="glass h-full w-72 overflow-hidden rounded-2xl">{sidebar}</div>
      </div>

      {/* Mobile: spring-in glass drawer */}
      <AnimatePresence>
        {sidebarOpen && (
          <>
            <motion.div
              key="scrim"
              className="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm md:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSidebarOpen(false)}
            />
            <motion.div
              key="drawer"
              className="fixed inset-y-0 left-0 z-40 w-72 p-2 md:hidden"
              initial={{ x: '-105%' }}
              animate={{ x: 0 }}
              exit={{ x: '-105%' }}
              transition={{ type: 'spring', stiffness: 360, damping: 34 }}
            >
              <div className="glass-strong h-full w-full overflow-hidden rounded-2xl">{sidebar}</div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Main chat panel */}
      <div className="glass flex min-w-0 flex-1 flex-col overflow-hidden md:rounded-2xl">
        <ChatTopBar
          title={activeTitle}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={toggleSidebar}
          saved={chat.lastSaved}
          onContinueElsewhere={() => setShowContinue(true)}
          onOpenFiles={() => setShowFiles(true)}
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
            uiMode={mode}
            approval={chat.approval}
            compactionNotice={chat.compactionNotice}
            knowledgeNotice={chat.knowledgeNotice}
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
            uiMode={mode}
            onUiModeChange={changeMode}
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
          <SkillsModal skills={skills} onClose={() => setShowSkills(false)} onChange={refreshSkills} />
        )}
        {showContinue && (
          <ContinueModal
            transcript={continueTranscript}
            onClose={() => setShowContinue(false)}
            onRedeemed={handleRedeemed}
          />
        )}
        {chat.contextApproval && (
          <ContextApprovalDialog info={chat.contextApproval} onResolve={chat.resolveContextApproval} />
        )}
      </AnimatePresence>
    </div>
    </MotionConfig>
  );
}
