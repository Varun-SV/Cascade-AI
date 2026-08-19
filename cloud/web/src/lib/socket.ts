import { io, type Socket } from 'socket.io-client';
import { adoptAssignedClientId, clientId } from './client-id.js';

let socket: Socket | null = null;

/** One shared socket per page — the server allows only one run in flight per connection. */
export function getSocket(): Socket {
  if (!socket) {
    const created = io({
      withCredentials: true,
      autoConnect: true,
      reconnection: true,
      // Resent on every reconnection attempt, which is what makes it usable as
      // the identity a held run is matched against.
      auth: { clientId: clientId() },
    });

    // The server asks this before letting another socket claim our resume key.
    // Answering is what proves this tab is still here, and is the difference
    // between a duplicated tab being given its own identity and it taking this
    // tab's in-flight run.
    created.on('resume:probe', (ack?: (alive: boolean) => void) => {
      if (typeof ack === 'function') ack(true);
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
