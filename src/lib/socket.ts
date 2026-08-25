import type { Server } from 'socket.io';

// Set once from index.ts after the HTTP server boots, then imported wherever
// a module needs to emit (ledger, dispatch) without creating circular imports.
let io: Server | undefined;

export function setSocketServer(server: Server) {
  io = server;
}

export function getSocketServer(): Server {
  if (!io) throw new Error('Socket.io server not initialized yet');
  return io;
}
