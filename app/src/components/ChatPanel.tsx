import { useState, useRef, useEffect } from 'react';
import type { Socket } from 'socket.io-client';
import { Send, Bot, User, ChevronRight, ChevronDown } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { SessionRating } from './SessionRating.js';
import { useAppDispatch, useAppSelector, appendMessage, updateLastMessage } from '../store/index.js';

// Reasoning-tuned models (Anthropic thinking_delta, OpenAI reasoning_content,
// and local GGUF models that emit it natively) all surface their "thinking"
// as literal `<think>...</think>` markup inline in the streamed text (see
// src/providers/anthropic.ts and src/providers/openai.ts). Split it out at
// render time so it can be shown collapsed instead of mixed into the answer.
// An unterminated trailing `<think>` (no closing tag has streamed in yet)
// means the model is still thinking — treat everything after it as
// in-progress thinking, not as answer text.
function splitThinking(content: string): { thinking: string; answer: string; thinkingOpen: boolean } {
  let thinking = '';
  let thinkingOpen = false;

  let answer = content.replace(/<think>([\s\S]*?)<\/think>\s*/g, (_m, inner: string) => {
    thinking += (thinking ? '\n\n' : '') + inner.trim();
    return '';
  });

  const openIdx = answer.indexOf('<think>');
  if (openIdx !== -1) {
    thinkingOpen = true;
    thinking += (thinking ? '\n\n' : '') + answer.slice(openIdx + '<think>'.length).trim();
    answer = answer.slice(0, openIdx);
  }

  return { thinking, answer, thinkingOpen };
}

function BlinkCursor({ marginLeft = 0 }: { marginLeft?: number }) {
  return <span style={{ display: 'inline-block', width: 7, height: 14, marginLeft, background: 'var(--accent)', borderRadius: 1, animation: 'blink 1s step-end infinite', verticalAlign: 'middle' }} />;
}

function ThinkingBlock({ text, open }: { text: string; open: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return null;
  return (
    <div style={{ marginBottom: 8 }}>
      <button
        onClick={() => setExpanded((e) => !e)}
        style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', fontSize: 11, padding: 0 }}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{open ? 'Thinking…' : 'Thinking'}</span>
        {open && <span style={{ display: 'inline-block', width: 5, height: 5, borderRadius: '50%', background: 'var(--accent)', animation: 'blink 1s step-end infinite' }} />}
      </button>
      {expanded && (
        <div style={{ marginTop: 4, padding: '6px 10px', background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11.5, color: 'var(--text-dim)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
          {text}
        </div>
      )}
    </div>
  );
}

// Reuses the themed code/heading/list rendering already proven in
// app/src/help/DocsViewer.tsx, tuned for the chat bubble's own text color.
const markdownComponents = {
  code({ className, children, ...rest }: { className?: string; children?: React.ReactNode }) {
    const match = /language-(\w+)/.exec(className ?? '');
    return match ? (
      <SyntaxHighlighter
        style={vscDarkPlus as Record<string, React.CSSProperties>}
        language={match[1]}
        PreTag="div"
        customStyle={{ borderRadius: 6, fontSize: 12 }}
      >
        {String(children).replace(/\n$/, '')}
      </SyntaxHighlighter>
    ) : (
      <code {...rest} style={{ background: 'var(--bg-base)', padding: '1px 5px', borderRadius: 3, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        {children}
      </code>
    );
  },
  p: ({ children }: { children?: React.ReactNode }) => <p style={{ margin: '0 0 8px', color: 'var(--text)' }}>{children}</p>,
  ul: ({ children }: { children?: React.ReactNode }) => <ul style={{ margin: '0 0 8px', paddingLeft: 20, color: 'var(--text)' }}>{children}</ul>,
  ol: ({ children }: { children?: React.ReactNode }) => <ol style={{ margin: '0 0 8px', paddingLeft: 20, color: 'var(--text)' }}>{children}</ol>,
  li: ({ children }: { children?: React.ReactNode }) => <li style={{ marginBottom: 2 }}>{children}</li>,
  strong: ({ children }: { children?: React.ReactNode }) => <strong style={{ color: 'var(--text)', fontWeight: 600 }}>{children}</strong>,
  h1: ({ children }: { children?: React.ReactNode }) => <h1 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 8px', color: 'var(--text)' }}>{children}</h1>,
  h2: ({ children }: { children?: React.ReactNode }) => <h2 style={{ fontSize: 13.5, fontWeight: 600, margin: '10px 0 6px', color: 'var(--text)' }}>{children}</h2>,
  h3: ({ children }: { children?: React.ReactNode }) => <h3 style={{ fontSize: 13, fontWeight: 600, margin: '8px 0 4px', color: 'var(--text)' }}>{children}</h3>,
  table: ({ children }: { children?: React.ReactNode }) => <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12, marginBottom: 8 }}>{children}</table>,
  th: ({ children }: { children?: React.ReactNode }) => <th style={{ padding: '4px 8px', borderBottom: '1px solid var(--border)', textAlign: 'left', color: 'var(--text)', fontWeight: 600 }}>{children}</th>,
  td: ({ children }: { children?: React.ReactNode }) => <td style={{ padding: '4px 8px', borderBottom: '1px solid var(--border)', color: 'var(--text)' }}>{children}</td>,
};

function MessageBubble({ message, compact }: { message: { role: string; content: string; streaming?: boolean }; compact?: boolean }) {
  const isUser = message.role === 'user';
  const { thinking, answer, thinkingOpen } = isUser
    ? { thinking: '', answer: message.content, thinkingOpen: false }
    : splitThinking(message.content);
  const hasThinking = !isUser && thinking.length > 0;
  const hasAnswer = answer.trim().length > 0;

  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexDirection: isUser ? 'row-reverse' : 'row', animation: 'fadeIn 0.25s var(--ease)' }}>
      <div style={{
        width: compact ? 24 : 30, height: compact ? 24 : 30, borderRadius: '50%', flexShrink: 0,
        background: isUser ? 'linear-gradient(135deg, var(--accent), var(--accent-2))' : 'var(--bg-raised)',
        border: isUser ? 'none' : '1px solid var(--border)',
        color: isUser ? '#fff' : 'var(--accent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {isUser ? <User size={compact ? 12 : 14} /> : <Bot size={compact ? 12 : 14} />}
      </div>
      <div style={{
        maxWidth: compact ? '92%' : '74%', background: isUser ? 'var(--accent-soft)' : 'var(--bg-raised)',
        border: `1px solid ${isUser ? 'var(--accent-dim)' : 'var(--border)'}`,
        borderRadius: isUser ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
        padding: compact ? '7px 10px' : '9px 13px',
        fontSize: compact ? 12 : 13, lineHeight: 1.65, wordBreak: 'break-word',
        color: 'var(--text)',
      }}>
        {hasThinking && <ThinkingBlock text={thinking} open={thinkingOpen} />}
        {hasAnswer ? (
          isUser
            ? <span style={{ whiteSpace: 'pre-wrap' }}>{message.content}</span>
            : <ReactMarkdown components={markdownComponents}>{answer}</ReactMarkdown>
        ) : (
          !hasThinking && message.streaming ? <BlinkCursor /> : null
        )}
        {hasAnswer && message.streaming && <BlinkCursor marginLeft={2} />}
      </div>
    </div>
  );
}

interface Props {
  socket: Socket | null;
  /** Tighter spacing/type scale for the Code view's docked sidebar. */
  compact?: boolean;
}

/**
 * The message list + input shared by the full-page Chat view and the Code
 * view's docked chat panel — both read/write the same session messages, so
 * this is a single source of truth rather than two divergent copies.
 */
export function ChatPanel({ socket, compact }: Props) {
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
    // Streaming tokens are appended by the global handler in App.tsx (so they
    // also update when you're on another view). Here we only react to
    // completion to stop the cursor and offer rating.
    const onComplete = () => {
      dispatch(updateLastMessage({ content: '', streaming: false }));
      setStreaming(false);
      setSessionDone(true);
    };
    socket.on('session:complete', onComplete);
    return () => { socket.off('session:complete', onComplete); };
  }, [socket, dispatch]);

  const send = () => {
    if (!input.trim() || !socket || streaming) return;
    const userMsg = { id: crypto.randomUUID(), role: 'user' as const, content: input.trim(), timestamp: Date.now() };
    const assistantMsg = { id: crypto.randomUUID(), role: 'assistant' as const, content: '', timestamp: Date.now(), streaming: true };
    dispatch(appendMessage(userMsg));
    dispatch(appendMessage(assistantMsg));
    socket.emit('cascade:run', { prompt: input.trim(), model: activeModel.chat });
    setInput('');
    setStreaming(true);
    setSessionDone(false);
  };

  const canSend = !!input.trim() && !!socket && !streaming;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: compact ? 12 : 18, display: 'flex', flexDirection: 'column', gap: compact ? 12 : 18 }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', marginTop: compact ? 24 : 64, animation: 'fadeIn 0.3s var(--ease)' }}>
            {!compact && (
              <div style={{
                width: 56, height: 56, borderRadius: 'var(--radius-lg)', margin: '0 auto 16px',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'linear-gradient(135deg, var(--accent), var(--accent-2))',
                color: '#fff', boxShadow: 'var(--glow-accent)',
              }}>
                <Bot size={26} />
              </div>
            )}
            <div style={{ fontSize: compact ? 13 : 16, fontWeight: 700, color: 'var(--text)', marginBottom: 5, letterSpacing: '-0.2px' }}>Cascade AI</div>
            <div style={{ fontSize: compact ? 11.5 : 13 }}>Multi-tier AI orchestration. Ask anything.</div>
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} compact={compact} />
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
        padding: compact ? 8 : 12, borderTop: '1px solid var(--border)',
        background: 'var(--bg-surface)', display: 'flex', gap: compact ? 6 : 10, alignItems: 'flex-end',
      }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Message Cascade…  (Enter to send)"
          rows={compact ? 1 : 2}
          style={{
            flex: 1, resize: 'none', background: 'var(--bg-raised)',
            border: `1px solid ${focused ? 'var(--accent)' : 'var(--border)'}`,
            borderRadius: 'var(--radius-md)',
            color: 'var(--text)', padding: compact ? '7px 9px' : '9px 12px', fontSize: compact ? 12 : 13,
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
            width: compact ? 34 : 42, height: compact ? 34 : 42,
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
          <Send size={compact ? 14 : 16} />
        </button>
      </div>
    </div>
  );
}
