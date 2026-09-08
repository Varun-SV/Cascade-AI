import { io, type Socket } from 'socket.io-client';
import { adoptAssignedClientId, clientId } from './client-id.js';

let socket: Socket | null = null;

/** One shared socket per page — the server allows only one run in flight per connection. */
export function getSocket(): Socket {
  if (!socket) {
    const created = io({
      withCredentials: true,
      // NOT auto-connected. `App` calls `getSocket()` during render, so an
      // auto-connecting socket is already in flight while React is still
      // committing — and the chat hook only attaches its listeners in an effect
      // afterwards. The server sends `run:resumed` the moment it accepts the
      // connection, immediately followed by the held run's live view and any
      // pending approval, and all three are ONE-SHOT: nothing re-sends them.
      // Losing that race leaves a reloaded page attached to a run still driving
      // a real browser, with no way to see it and no way to stop it.
      //
      // The effect usually wins by a wide margin. "Usually" is not a property.
      // `useChatSession` connects once its handlers are attached, which makes
      // subscribe-before-connect an invariant instead of a likelihood — see the
      // effect at the end of that hook.
      autoConnect: false,
      reconnection: true,
      // Resent on every reconnection attempt, which is what makes it usable as
      // the identity a held run is matched against.
      auth: { clientId: clientId() },
    });

    // Issued when the server found this connection colliding with a live one.
    // Adopting it here — rather than only in the chat hook — keeps identity a
    // property of the connection, and applies even on a page that never runs
    // anything.
    created.on('run:resumed', (event: { clientId?: string }) => {
      if (event?.clientId) {
        adoptAssignedClientId(event.clientId);
        created.auth = { clientId: event.clientId };
      }
    });

    socket = created;
  }
  return socket;
}

export function closeSocket(): void {
  socket?.close();
  socket = null;
}
