import { useState, useRef, useEffect } from 'react';
import type { Socket } from 'socket.io-client';
import { Send, Bot, User, MessageSquare } from 'lucide-react';
import { ModelPicker } from '../components/ModelPicker.js';
import { HelpButton } from '../help/HelpButton.js';
import { SessionRating } from '../components/SessionRating.js';
import { useAppDispatch, useAppSelector, appendMessage, updateLastMessage, setActiveModelT1 } from '../store/index.js';

export function ChatView({ socket }: { socket: Socket | null }) {
  const dispatch = useAppDispatch();
  const messages = useAppSelector((s) => s.app.messages);
  const sessionId = useAppSelector((s) => s.app.sessionId);
  const { activeModel } = useAppSelector((s) => s.app);
  const [input, setInput] = useState('');
  const [focused, setFocused] = useState(false);
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

  const canSend = !!input.trim() && !!socket && !streaming;

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
          value={activeModel.t1}
          onChange={(id) => dispatch(setActiveModelT1(id))}
        />
        <div style={{ flex: 1 }} />
        <HelpButton context="chat" />
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 18 }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', marginTop: 64, animation: 'fadeIn 0.3s var(--ease)' }}>
            <div style={{
              width: 56, height: 56, borderRadius: 'var(--radius-lg)', margin: '0 auto 16px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'linear-gradient(135deg, var(--accent), var(--accent-2))',
              color: '#fff', boxShadow: 'var(--glow-accent)',
            }}>
              <Bot size={26} />
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', marginBottom: 5, letterSpacing: '-0.2px' }}>Cascade AI</div>
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
        background: 'var(--bg-surface)', display: 'flex', gap: 10, alignItems: 'flex-end',
      }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Message Cascade…  (Enter to send)"
          rows={2}
          style={{
            flex: 1, resize: 'none', background: 'var(--bg-raised)',
            border: `1px solid ${focused ? 'var(--accent)' : 'var(--border)'}`,
            borderRadius: 'var(--radius-md)',
            color: 'var(--text)', padding: '9px 12px', fontSize: 13,
            fontFamily: 'inherit', outline: 'none', lineHeight: 1.5,
            boxShadow: focused ? 'var(--glow-accent)' : 'none',
            transition: 'border-color var(--dur), box-shadow var(--dur)',
          }}
        />
        <button
          onClick={send}
          disabled={!canSend}
          title="Send"
          style={{
            width: 42, height: 42,
            background: canSend ? 'linear-gradient(135deg, var(--accent), var(--accent-2))' : 'var(--bg-raised)',
            color: canSend ? '#fff' : 'var(--text-dim)',
            border: canSend ? 'none' : '1px solid var(--border)', borderRadius: 'var(--radius-md)',
            cursor: canSend ? 'pointer' : 'default',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: canSend ? 'var(--shadow-1)' : 'none',
            transition: 'background var(--dur), transform var(--dur)',
          }}
          onMouseEnter={(e) => { if (canSend) (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.transform = 'none'; }}
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: { role: string; content: string; streaming?: boolean } }) {
  const isUser = message.role === 'user';
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexDirection: isUser ? 'row-reverse' : 'row', animation: 'fadeIn 0.25s var(--ease)' }}>
      <div style={{
        width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
        background: isUser ? 'linear-gradient(135deg, var(--accent), var(--accent-2))' : 'var(--bg-raised)',
        border: isUser ? 'none' : '1px solid var(--border)',
        color: isUser ? '#fff' : 'var(--accent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {isUser ? <User size={14} /> : <Bot size={14} />}
      </div>
      <div style={{
        maxWidth: '74%', background: isUser ? 'var(--accent-soft)' : 'var(--bg-raised)',
        border: `1px solid ${isUser ? 'var(--accent-dim)' : 'var(--border)'}`,
        borderRadius: isUser ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
        padding: '9px 13px',
        fontSize: 13, lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        color: 'var(--text)',
      }}>
        {message.content || (message.streaming ? <span style={{ display: 'inline-block', width: 7, height: 14, background: 'var(--accent)', borderRadius: 1, animation: 'blink 1s step-end infinite', verticalAlign: 'middle' }} /> : null)}
        {message.content && message.streaming && (
          <span style={{ display: 'inline-block', width: 7, height: 14, marginLeft: 2, background: 'var(--accent)', borderRadius: 1, animation: 'blink 1s step-end infinite', verticalAlign: 'middle' }} />
        )}
      </div>
    </div>
  );
}
