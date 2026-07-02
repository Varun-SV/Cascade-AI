import type { ChatMessage } from '../store/index.js';

interface StoredMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

/**
 * Fetch a stored session's transcript from the backend (GET /api/sessions/:id
 * returns the session with its messages) and map it to the UI's ChatMessage
 * shape. System messages are internal — only user/assistant turns are shown.
 * Returns null when the backend is unreachable or the session is gone.
 */
export async function fetchSessionTranscript(
  backendPort: number,
  authToken: string,
  sessionId: string,
): Promise<ChatMessage[] | null> {
  try {
    const res = await fetch(`http://localhost:${backendPort}/api/sessions/${sessionId}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) return null;
    const session = (await res.json()) as { messages?: StoredMessage[] };
    return (session.messages ?? [])
      .filter((m): m is StoredMessage & { role: 'user' | 'assistant' } => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        id: m.id,
        role: m.role,
        content: typeof m.content === 'string' ? m.content : String(m.content),
        timestamp: Date.parse(m.timestamp) || Date.now(),
      }));
  } catch {
    return null;
  }
}
