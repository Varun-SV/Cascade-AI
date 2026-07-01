import type { Socket } from 'socket.io-client';
import { MessageSquare } from 'lucide-react';
import { ModelPicker } from '../components/ModelPicker.js';
import { HelpButton } from '../help/HelpButton.js';
import { ChatPanel } from '../components/ChatPanel.js';
import { useAppDispatch, useAppSelector, setActiveModelChat } from '../store/index.js';

export function ChatView({ socket }: { socket: Socket | null }) {
  const dispatch = useAppDispatch();
  const { activeModel } = useAppSelector((s) => s.app);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        padding: '11px 16px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <MessageSquare size={15} style={{ color: 'var(--accent)' }} />
        <span style={{ fontWeight: 700, fontSize: 13, letterSpacing: '-0.2px' }}>Chat</span>
        <ModelPicker
          value={activeModel.chat}
          onChange={(id) => dispatch(setActiveModelChat(id))}
        />
        <div style={{ flex: 1 }} />
        <HelpButton context="chat" />
      </div>

      <div style={{ flex: 1, overflow: 'hidden' }}>
        <ChatPanel socket={socket} />
      </div>
    </div>
  );
}
