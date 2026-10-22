import type { ViewMode } from '../store/index.js';

/**
 * Where "New chat" in the session sidebar leaves you. Mission Control and Chat
 * both run a session in place, so the fresh one starts where you are; any other
 * view (Insights, Browser) has nowhere to type, so it opens Chat. Returns null
 * when the view should stay as it is.
 */
export function newChatView(view: ViewMode): ViewMode | null {
  return view === 'cockpit' || view === 'chat' || view === 'code' ? null : 'chat';
}
