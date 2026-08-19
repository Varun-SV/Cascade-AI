import { io, type Socket } from 'socket.io-client';
import { claimClientId } from './client-id.js';

let socket: Socket | null = null;

/** One shared socket per page — the server allows only one run in flight per connection. */
export function getSocket(): Socket {
  if (!socket) {
    // Rotation reconnects rather than mutating in place: the identity is sent
    // on the handshake, so the server only learns the new one on a new
    // connection. Until then this tab simply shares a key it will give up.
    const clientId = claimClientId((rotated) => {
      if (!socket) return;
      socket.auth = { clientId: rotated };
      socket.disconnect().connect();
    });
    socket = io({
      withCredentials: true,
      autoConnect: true,
      reconnection: true,
      // Resent on every reconnection attempt, which is what makes it usable as
      // the identity the server matches a held run against.
      auth: { clientId },
    });
  }
  return socket;
}

export function closeSocket(): void {
  socket?.close();
  socket = null;
}
