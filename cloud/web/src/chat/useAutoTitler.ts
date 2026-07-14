import { useEffect, useRef } from 'react';
import { generateLocalTitle } from '../lib/localModel/titler.js';
import { renameConversation } from '../lib/api.js';
import type { ChatMessage } from './useChatSession.js';

// How long the chat must sit idle before we spend on-device compute to title it.
const IDLE_MS = 6000;

interface Options {
  enabled: boolean;
  conversationId: string | undefined;
  messages: ChatMessage[];
  busy: boolean;
  /** Called after a title lands so the sidebar can refresh. */
  onTitled: () => void;
}

/**
 * When the opt-in on-device model is enabled and the chat has been idle for a
 * bit, generate a concise title for the current conversation and save it. Each
 * conversation is titled at most once per session; the model (and its download)
 * only ever loads if this actually fires.
 */
export function useAutoTitler({ enabled, conversationId, messages, busy, onTitled }: Options) {
  const doneRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (!enabled || busy || !conversationId || doneRef.current.has(conversationId)) return;

    const firstUser = messages.find((m) => m.role === 'user')?.content?.trim();
    const firstAssistant = messages.find((m) => m.role === 'assistant' && !m.streaming)?.content?.trim();
    if (!firstUser || !firstAssistant) return;

    const id = conversationId;
    timerRef.current = setTimeout(() => {
      // Mark up-front so a re-render mid-generation doesn't double-fire.
      doneRef.current.add(id);
      void (async () => {
        const title = await generateLocalTitle(firstUser, firstAssistant);
        if (!title) { doneRef.current.delete(id); return; } // let a later idle retry
        try {
          await renameConversation(id, title);
          onTitled();
        } catch {
          doneRef.current.delete(id);
        }
      })();
    }, IDLE_MS);

    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [enabled, busy, conversationId, messages, onTitled]);
}
