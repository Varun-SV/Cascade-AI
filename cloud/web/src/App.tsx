import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
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
import type { CloudConversation, CloudUser, ProviderConfig, Skill } from './lib/types.js';

const SIDEBAR_OPEN_KEY = 'cascade-cloud-sidebar-open';
const DEFAULT_SKILL = 'general';

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
    return <div className="flex h-screen items-center justify-center bg-ink-950 text-ink-400">Loading…</div>;
  }

  if (!user) {
    return <LoginGate config={config} onDevLogin={refreshMe} />;
  }

  const activeTitle = conversations.find((c) => c.id === chat.conversationId)?.title ?? undefined;

  return (
    <div className="flex h-screen overflow-hidden bg-ink-950">
      <div
        className={clsx(
          'fixed inset-y-0 left-0 z-30 w-64 shrink-0 overflow-hidden border-r border-ink-700 bg-ink-900 transition-all duration-200 md:relative md:translate-x-0',
          sidebarOpen ? 'translate-x-0 md:w-64' : '-translate-x-full md:w-0 md:border-r-0',
        )}
      >
        <div className="h-full w-64">
          <ConversationSidebar
            user={user}
            conversations={conversations}
            activeConversationId={chat.conversationId}
            lastTokens={chat.lastTokens}
            usageRefreshSignal={chat.busy}
            onSelect={selectConversation}
            onNewChat={newChat}
            onOpenKeyVault={() => setShowVault(true)}
            onOpenUpgrade={() => setShowUpgrade(true)}
            onOpenMemory={() => setShowMemory(true)}
            onLogout={handleLogout}
          />
        </div>
      </div>

      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/60 backdrop-blur-sm md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <ChatTopBar title={activeTitle} sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} />
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
            onRegenerate={chat.regenerate}
          />
        </div>
      </div>

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
    </div>
  );
}
