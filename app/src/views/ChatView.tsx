import { useState, useRef, useEffect } from 'react';
import type { Socket } from 'socket.io-client';
import { Send, Bot, User } from 'lucide-react';
import { ModelPicker } from '../components/ModelPicker.js';
import { HelpButton } from '../help/HelpButton.js';
import { SessionRating } from '../components/SessionRating.js';
import { useAppDispatch, useAppSelector, appendMessage, updateLastMessage } from '../store/index.js';

export function ChatView({ socket }: { socket: Socket | null }) {
  const dispatch = useAppDispatch();
  const messages = useAppSelector((s) => s.app.messages);
  const sessionId = useAppSelector((s) => s.app.sessionId);
  const { activeModel } = useAppSelector((s) => s.app);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [sessionDone, setSessionDone] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (!socket) return;
    const onStream = (data: { text: string }) => {
      dispatch(updateLastMessage({ content: data.text, streaming: true }));
    };
    const onComplete = () => {
      dispatch(updateLastMessage({ content: '', streaming: false }));
      setStreaming(false);
      setSessionDone(true);
    };
    socket.on('stream:token', onStream);
    socket.on('session:complete', onComplete);
    return () => { socket.off('stream:token', onStream); socket.off('session:complete', onComplete); };
  }, [socket, dispatch]);

  const send = () => {
    if (!input.trim() || !socket || streaming) return;
    const userMsg = { id: crypto.randomUUID(), role: 'user' as const, content: input.trim(), timestamp: Date.now() };
    const assistantMsg = { id: crypto.randomUUID(), role: 'assistant' as const, content: '', timestamp: Date.now(), streaming: true };
    dispatch(appendMessage(userMsg));
    dispatch(appendMessage(assistantMsg));
    socket.emit('cascade:run', { prompt: input.trim(), model: activeModel.t1 });
    setInput('');
    setStreaming(true);
    setSessionDone(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        padding: '10px 16px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{ fontWeight: 600 }}>Chat</span>
        <ModelPicker tier="t1" />
        <div style={{ flex: 1 }} />
        <HelpButton context="chat" />
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', marginTop: 60 }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>🌊</div>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Cascade AI</div>
            <div style={{ fontSize: 13 }}>Multi-tier AI orchestration. Ask anything.</div>
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        {sessionDone && messages.length > 0 && (
          <div style={{ padding: '0 4px' }}>
            <SessionRating socket={socket} sessionId={sessionId} />
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{
        padding: 12, borderTop: '1px solid var(--border)',
        background: 'var(--bg-surface)', display: 'flex', gap: 8, alignItems: 'flex-end',
      }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Message Cascade… (Enter to send)"
          rows={2}
          style={{
            flex: 1, resize: 'none', background: 'var(--bg-raised)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius)',
            color: 'var(--text)', padding: '8px 12px', fontSize: 13,
            fontFamily: 'inherit', outline: 'none',
          }}
        />
        <button
          onClick={send}
          disabled={!input.trim() || streaming || !socket}
          style={{
            width: 40, height: 40,
            background: input.trim() && socket ? 'var(--accent)' : 'var(--bg-raised)',
            color: input.trim() && socket ? '#fff' : 'var(--text-muted)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius)',
            cursor: input.trim() && socket && !streaming ? 'pointer' : 'default',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'background 0.15s',
          }}
        >
          <Send size={15} />
        </button>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: { role: string; content: string; streaming?: boolean } }) {
  const isUser = message.role === 'user';
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexDirection: isUser ? 'row-reverse' : 'row' }}>
      <div style={{
        width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
        background: isUser ? 'var(--accent)' : 'var(--bg-raised)',
        border: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {isUser ? <User size={14} /> : <Bot size={14} />}
      </div>
      <div style={{
        maxWidth: '70%', background: isUser ? 'var(--accent-dim)' : 'var(--bg-raised)',
        border: `1px solid ${isUser ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 'var(--radius)', padding: '8px 12px',
        fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>
        {message.content || (message.streaming ? <span style={{ color: 'var(--text-muted)' }}>▋</span> : null)}
      </div>
    </div>
  );
}
