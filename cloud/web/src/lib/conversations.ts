import type { CloudConversation } from './types.js';

/**
 * The open chat's title. The recent list holds only the newest page, so a
 * chat opened from search may not be in it; then the title the server
 * returned when the chat was opened stands in.
 */
export function titleOf(
  id: string | undefined,
  recent: Array<Pick<CloudConversation, 'id' | 'title'>>,
  opened: { id: string; title: string | null } | null,
): string | undefined {
  if (!id) return undefined;
  const listed = recent.find((c) => c.id === id);
  if (listed) return listed.title ?? undefined;
  return opened?.id === id ? opened.title ?? undefined : undefined;
}
