import { useCallback, useEffect, useState } from 'react';
import LoginGate from './components/LoginGate.js';
import UpgradeModal from './components/UpgradeModal.js';
import ConversationSidebar from './chat/ConversationSidebar.js';
import ChatPanel from './chat/ChatPanel.js';
import KeyVault from './keys/KeyVault.js';
import { useChatSession } from './chat/useChatSession.js';
import { loadKeys, saveKeys } from './keys/store.js';
import { fetchConfig, fetchMe, getMessages, listConversations, logout, type CloudConfig } from './lib/api.js';
import { closeSocket, getSocket } from './lib/socket.js';
import type { CloudConversation, CloudUser, ProviderConfig } from './lib/types.js';

export default function App() {
  const [config, setConfig] = useState<CloudConfig | null>(null);
  const [user, setUser] = useState<CloudUser | null | undefined>(undefined);
  const [conversations, setConversations] = useState<CloudConversation[]>([]);
  const [providers, setProviders] = useState<ProviderConfig[]>(() => loadKeys());
  const [showVault, setShowVault] = useState(false);
  const [showUpgrade, setShowUpgrade] = useState(false);

  useEffect(() => {
    fetchConfig()
      .then(setConfig)
      .catch(() => setConfig({ githubEnabled: false, googleEnabled: false, googleClientId: null, devLoginEnabled: false }));
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
  const chat = useChatSession(socket, providers);

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
    const { messages } = await getMessages(id);
    chat.setConversationId(id);
    chat.loadMessages(messages.map((m) => ({ id: m.id, role: m.role === 'user' ? 'user' : 'assistant', content: m.content })));
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
    return <div className="flex h-screen items-center justify-center bg-cascade-950 text-cascade-400">Loading…</div>;
  }

  if (!user) {
    return <LoginGate config={config} onDevLogin={refreshMe} />;
  }

  return (
    <div className="flex h-screen bg-cascade-950">
      <ConversationSidebar
        user={user}
        conversations={conversations}
        activeConversationId={chat.conversationId}
        onSelect={selectConversation}
        onNewChat={newChat}
        onOpenKeyVault={() => setShowVault(true)}
        onOpenUpgrade={() => setShowUpgrade(true)}
        onLogout={handleLogout}
      />
      <div className="min-w-0 flex-1">
        <ChatPanel
          messages={chat.messages}
          busy={chat.busy}
          error={chat.error}
          hasProviders={providers.length > 0}
          onSend={chat.send}
        />
      </div>

      {showVault && (
        <div
          className="fixed inset-0 z-10 flex items-center justify-center bg-black/60"
          onClick={() => setShowVault(false)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-cascade-800 bg-cascade-950"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-cascade-900 px-4 py-3">
              <h2 className="text-sm font-semibold text-cascade-100">API keys</h2>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setShowVault(false)}
                className="text-cascade-400 hover:text-cascade-100"
              >
                ✕
              </button>
            </div>
            <KeyVault
              keys={providers}
              onChange={updateProviders}
              driveSyncEnabled={user.provider === 'google'}
              googleClientId={config.googleClientId}
            />
          </div>
        </div>
      )}

      {showUpgrade && (
        <div
          className="fixed inset-0 z-10 flex items-center justify-center bg-black/60"
          onClick={() => setShowUpgrade(false)}
        >
          <div
            className="w-full max-w-lg rounded-xl border border-cascade-800 bg-cascade-950"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-cascade-900 px-4 py-3">
              <h2 className="text-sm font-semibold text-cascade-100">Upgrade</h2>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setShowUpgrade(false)}
                className="text-cascade-400 hover:text-cascade-100"
              >
                ✕
              </button>
            </div>
            <UpgradeModal />
          </div>
        </div>
      )}
    </div>
  );
}
