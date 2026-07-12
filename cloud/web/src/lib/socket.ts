import { io, type Socket } from 'socket.io-client';

let socket: Socket | null = null;

/** One shared socket per page — the server allows only one run in flight per connection. */
export function getSocket(): Socket {
  if (!socket) {
    socket = io({
      withCredentials: true,
      autoConnect: true,
      reconnection: true,
    });
  }
  return socket;
}

export function closeSocket(): void {
  socket?.close();
  socket = null;
}
