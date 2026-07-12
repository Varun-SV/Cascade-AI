import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { ProviderConfig } from '../lib/types.js';

export interface ChatAttachment {
  id: string;
  mime: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  attachments?: ChatAttachment[];
  costUsd?: number | null;
}

export interface SendInput {
  prompt: string;
  attachments?: ChatAttachment[];
}

interface ChatRunAck {
  conversationId?: string;
  output?: string;
  costUsd?: number;
  totalTokens?: number;
  error?: string;
}

// Maps a tier event to a human-legible activity label. Cascade streams
// tier:status as it moves T1 → T2 → T3; the exact payload shape varies, so we
// read whatever tier marker is present and fall back to a generic label.
function statusLabel(e: Record<string, unknown>): string {
  const tier = String(e['tierId'] ?? e['tier'] ?? e['id'] ?? '').toUpperCase();
  if (tier.startsWith('T1')) return 'Planning…';
  if (tier.startsWith('T2')) return 'Coordinating…';
  if (tier.startsWith('T3')) return 'Executing…';
  return 'Working…';
}

export function useChatSession(
  socket: Socket | null,
  providers: ProviderConfig[],
  skillId: string,
  initialConversationId?: string,
) {
  const [conversationId, setConversationId] = useState<string | undefined>(initialConversationId);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [lastTokens, setLastTokens] = useState<number>(0);
  const streamingRef = useRef('');

  useEffect(() => {
    setConversationId(initialConversationId);
  }, [initialConversationId]);

  useEffect(() => {
    if (!socket) return;
    const onToken = (e: { text: string }) => {
      streamingRef.current += e.text;
      setStatus(null); // tokens are flowing — drop the "planning" chip
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.streaming) {
          return [...prev.slice(0, -1), { ...last, content: streamingRef.current }];
        }
        return [...prev, { id: 'streaming', role: 'assistant', content: streamingRef.current, streaming: true }];
      });
    };
    const onStatus = (e: Record<string, unknown>) => setStatus(statusLabel(e));
    socket.on('stream:token', onToken);
    socket.on('tier:status', onStatus);
    return () => {
      socket.off('stream:token', onToken);
      socket.off('tier:status', onStatus);
    };
  }, [socket]);

  const loadMessages = useCallback((loaded: ChatMessage[]) => {
    setMessages(loaded);
    setError(null);
    setStatus(null);
  }, []);

  // Shared run path for a fresh send and for regenerate. `appendUser` is false
  // when regenerating (the user message already exists in the transcript).
  const runChat = useCallback(
    (prompt: string, attachments: ChatAttachment[] | undefined, appendUser: boolean) => {
      const text = prompt.trim();
      if (!socket || busy || !text) return;
      setBusy(true);
      setError(null);
      setStatus('Thinking…');
      streamingRef.current = '';
      if (appendUser) {
        setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', content: text, attachments }]);
      }

      socket.emit(
        'chat:run',
        { conversationId, prompt: text, providers, attachmentIds: attachments?.map((a) => a.id), skillId },
        (ack: ChatRunAck) => {
          setBusy(false);
          setStatus(null);
          if (ack.error) {
            setError(ack.error);
            setMessages((prev) => prev.filter((m) => !m.streaming));
            return;
          }
          if (typeof ack.totalTokens === 'number') setLastTokens(ack.totalTokens);
          setConversationId(ack.conversationId);
          setMessages((prev) => {
            const withoutStreaming = prev.filter((m) => !m.streaming);
            return [
              ...withoutStreaming,
              { id: crypto.randomUUID(), role: 'assistant', content: ack.output ?? '', costUsd: ack.costUsd ?? null },
            ];
          });
        },
      );
    },
    [socket, busy, conversationId, providers, skillId],
  );

  const send = useCallback((input: SendInput) => runChat(input.prompt, input.attachments, true), [runChat]);

  const regenerate = useCallback(() => {
    if (busy) return;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;
    // Drop the trailing assistant reply(ies) so the regenerated one replaces it.
    setMessages((prev) => {
      const copy = [...prev];
      while (copy.length && copy[copy.length - 1]?.role === 'assistant') copy.pop();
      return copy;
    });
    runChat(lastUser.content, lastUser.attachments, false);
  }, [busy, messages, runChat]);

  return { messages, send, regenerate, busy, error, status, lastTokens, conversationId, loadMessages, setConversationId };
}
