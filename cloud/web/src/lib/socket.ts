import { io, type Socket } from 'socket.io-client';
import { claimClientId } from './client-id.js';

let socket: Socket | null = null;

/**
 * One shared socket per page — the server allows only one run in flight per
 * connection.
 *
 * Created disconnected and connected only once the resume identity has
 * settled. That ordering is the whole point: the server treats a socket
 * arriving on an existing resume key as that client coming back and moves its
 * runs over immediately, so connecting on an id this tab might merely have
 * INHERITED (session storage is copied into a duplicated tab) would take the
 * original tab's work before the collision could be detected.
 */
export function getSocket(): Socket {
  if (!socket) {
    const created = io({
      withCredentials: true,
      autoConnect: false,
      reconnection: true,
    });
    socket = created;
    void claimClientId()
      .then((clientId) => {
        // Set before connecting: the identity travels on the handshake, and is
        // resent on every reconnection attempt, which is what makes it usable
        // as the key a held run is matched against.
        created.auth = clientId ? { clientId } : {};
        created.connect();
      })
      .catch(() => {
        // Never leave the page unable to talk to the server over an identity
        // problem — connect without one and forgo resumability.
        created.auth = {};
        created.connect();
      });
  }
  return socket;
}

export function closeSocket(): void {
  socket?.close();
  socket = null;
}
