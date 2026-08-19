import { io, type Socket } from 'socket.io-client';

let socket: Socket | null = null;

const CLIENT_ID_KEY = 'cascade.clientId';

/**
 * A stable id for THIS TAB, so the server can tell a reconnect from a stranger.
 *
 * The session cookie says which account is connecting, which is not the same
 * question as "is this the client whose run I am holding?". A user can have
 * several tabs open and Pro allows three concurrent runs, so without this the
 * first socket to arrive after a drop inherited every held run on the account —
 * another tab's tokens rendering in this one's chat, and this one's Stop
 * aborting a run it never started.
 *
 * `sessionStorage` is the right scope precisely because it is per-tab: it
 * survives the reload that a socket drop often accompanies, and a second tab
 * gets its own. A tab that cannot store one is simply not resumable, which is
 * the behaviour that existed before runs were held at all.
 */
function clientId(): string | undefined {
  try {
    const existing = sessionStorage.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    sessionStorage.setItem(CLIENT_ID_KEY, fresh);
    return fresh;
  } catch {
    return undefined;
  }
}

/** One shared socket per page — the server allows only one run in flight per connection. */
export function getSocket(): Socket {
  if (!socket) {
    socket = io({
      withCredentials: true,
      autoConnect: true,
      reconnection: true,
      // Resent on every reconnection attempt, which is what makes it usable as
      // the identity the server matches a held run against.
      auth: { clientId: clientId() },
    });
  }
  return socket;
}

export function closeSocket(): void {
  socket?.close();
  socket = null;
}
