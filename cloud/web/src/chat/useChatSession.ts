import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { ProviderConfig } from '../lib/types.js';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
}

interface ChatRunAck {
  conversationId?: string;
  output?: string;
  costUsd?: number;
  error?: string;
}

/**
 * One run in flight at a time (the server enforces this per-connection too),
 * so stream:token doesn't need conversationId filtering — there is only ever
 * one active run to attribute tokens to.
 */
export function useChatSession(socket: Socket | null, providers: ProviderConfig[], initialConversationId?: string) {
  const [conversationId, setConversationId] = useState<string | undefined>(initialConversationId);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamingRef = useRef('');

  useEffect(() => {
    setConversationId(initialConversationId);
  }, [initialConversationId]);

  useEffect(() => {
    if (!socket) return;
    const onToken = (e: { text: string }) => {
      streamingRef.current += e.text;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.streaming) {
          return [...prev.slice(0, -1), { ...last, content: streamingRef.current }];
        }
        return [...prev, { id: 'streaming', role: 'assistant', content: streamingRef.current, streaming: true }];
      });
    };
    socket.on('stream:token', onToken);
    return () => { socket.off('stream:token', onToken); };
  }, [socket]);

  const loadMessages = useCallback((loaded: ChatMessage[]) => {
    setMessages(loaded);
    setError(null);
  }, []);

  const send = useCallback((prompt: string) => {
    if (!socket || busy || !prompt.trim()) return;
    setBusy(true);
    setError(null);
    streamingRef.current = '';
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: prompt };
    setMessages((prev) => [...prev, userMessage]);

    socket.emit('chat:run', { conversationId, prompt, providers }, (ack: ChatRunAck) => {
      setBusy(false);
      if (ack.error) {
        setError(ack.error);
        setMessages((prev) => prev.filter((m) => !m.streaming));
        return;
      }
      setConversationId(ack.conversationId);
      setMessages((prev) => {
        const withoutStreaming = prev.filter((m) => !m.streaming);
        return [...withoutStreaming, { id: crypto.randomUUID(), role: 'assistant', content: ack.output ?? '' }];
      });
    });
  }, [socket, busy, conversationId, providers]);

  return { messages, send, busy, error, conversationId, loadMessages, setConversationId };
}
