import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import LoginGate from './components/LoginGate.js';
import Modal from './components/Modal.js';
import UpgradeModal from './components/UpgradeModal.js';
import MemoryModal from './components/MemoryModal.js';
import ConversationSidebar from './chat/ConversationSidebar.js';
import ChatPanel from './chat/ChatPanel.js';
import ChatTopBar from './chat/ChatTopBar.js';
import KeyVault from './keys/KeyVault.js';
import { useChatSession } from './chat/useChatSession.js';
import { loadKeys, saveKeys } from './keys/store.js';
import { fetchConfig, fetchMe, fetchSkills, getMessages, listConversations, logout, type CloudConfig } from './lib/api.js';
import { closeSocket, getSocket } from './lib/socket.js';
import type { CloudConversation, CloudUser, ProviderConfig, Skill, WhyReport } from './lib/types.js';

const SIDEBAR_OPEN_KEY = 'cascade-cloud-sidebar-open';
const DEFAULT_SKILL = 'general';

/** Parse a persisted /why JSON blob back into a WhyReport (null on absent/bad JSON). */
function parseWhy(raw: string | null): WhyReport | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WhyReport;
  } catch {
    return null;
  }
}

export default function App() {
  const [config, setConfig] = useState<CloudConfig | null>(null);
  const [user, setUser] = useState<CloudUser | null | undefined>(undefined);
  const [conversations, setConversations] = useState<CloudConversation[]>([]);
  const [providers, setProviders] = useState<ProviderConfig[]>(() => loadKeys());
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillId, setSkillId] = useState<string>(DEFAULT_SKILL);
  const [showVault, setShowVault] = useState(false);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    const stored = localStorage.getItem(SIDEBAR_OPEN_KEY);
    // No explicit preference yet: default open on desktop (today's always-visible
    // sidebar), closed on narrow viewports (a drawer covering the whole screen
    // on first mobile visit is a worse default than starting collapsed).
    return stored !== null ? stored !== '0' : window.innerWidth >= 768;
  });

  function toggleSidebar() {
    setSidebarOpen((open) => {
      const next = !open;
      localStorage.setItem(SIDEBAR_OPEN_KEY, next ? '1' : '0');
      return next;
    });
  }

  useEffect(() => {
    fetchConfig()
      .then(setConfig)
      .catch(() => setConfig({ githubEnabled: false, googleEnabled: false, googleClientId: null, devLoginEnabled: false }));
    fetchSkills().then((r) => setSkills(r.skills)).catch(() => setSkills([]));
  }, []);

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

  const socket = user ? getSocket() : null;
  const chat = useChatSession(socket, providers, skillId);

  // A run may have created a new conversation or renamed one — refresh the
  // sidebar once the run settles (covers the initial idle mount too, which
  // is a harmless extra fetch).
  useEffect(() => {
    if (user && !chat.busy) refreshConversations();
  }, [user, chat.busy, refreshConversations]);

  function updateProviders(next: ProviderConfig[]) {
    setProviders(next);
    saveKeys(next);
  }

  async function selectConversation(id: string) {
    const { conversation, messages } = await getMessages(id);
    chat.setConversationId(id);
    if (conversation?.skillId) setSkillId(conversation.skillId);
    chat.loadMessages(
      messages.map((m) => ({
        id: m.id,
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content,
        costUsd: m.costUsd,
        tier: m.tier,
        model: m.model,
        why: parseWhy(m.why),
        attachments: m.attachments?.map((a) => ({ id: a.id, mime: a.mime })),
      })),
    );
  }

  function newChat() {
    chat.setConversationId(undefined);
    chat.loadMessages([]);
  }

  async function handleLogout() {
    await logout();
    closeSocket();
    setUser(null);
    setConversations([]);
  }

  if (user === undefined || config === null) {
    return (
      <div className="flex h-screen items-center justify-center text-ink-400">
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
    return <LoginGate config={config} onDevLogin={refreshMe} />;
  }

  const activeTitle = conversations.find((c) => c.id === chat.conversationId)?.title ?? undefined;

  const sidebar = (
    <ConversationSidebar
      user={user}
      conversations={conversations}
      activeConversationId={chat.conversationId}
      lastTokens={chat.lastTokens}
      usageRefreshSignal={chat.busy}
      onSelect={(id) => { void selectConversation(id); if (window.innerWidth < 768) setSidebarOpen(false); }}
      onNewChat={() => { newChat(); if (window.innerWidth < 768) setSidebarOpen(false); }}
      onOpenKeyVault={() => setShowVault(true)}
      onOpenUpgrade={() => setShowUpgrade(true)}
      onOpenMemory={() => setShowMemory(true)}
      onLogout={handleLogout}
    />
  );

  return (
    <div className="relative flex h-screen gap-0 overflow-hidden md:gap-3 md:p-3">
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
        <ChatTopBar title={activeTitle} sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} saved={chat.lastSaved} />
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
            routingMode={chat.routingMode}
            onRoutingModeChange={chat.setRoutingMode}
            forceTier={chat.forceTier}
            onForceTierChange={chat.setForceTier}
            webSearch={chat.webSearch}
            onWebSearchChange={chat.setWebSearch}
          />
        </div>
      </div>

      <AnimatePresence>
        {showVault && (
          <Modal title="API keys" onClose={() => setShowVault(false)}>
            <KeyVault
              keys={providers}
              onChange={updateProviders}
              driveSyncEnabled={user.provider === 'google'}
              googleClientId={config.googleClientId}
            />
          </Modal>
        )}
        {showUpgrade && (
          <Modal title="Upgrade" onClose={() => setShowUpgrade(false)} maxWidth="max-w-lg">
            <UpgradeModal />
          </Modal>
        )}
        {showMemory && <MemoryModal onClose={() => setShowMemory(false)} />}
      </AnimatePresence>
    </div>
  );
}
