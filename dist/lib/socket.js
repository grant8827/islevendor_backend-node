// Set once from index.ts after the HTTP server boots, then imported wherever
// a module needs to emit (ledger, dispatch) without creating circular imports.
let io;
export function setSocketServer(server) {
    io = server;
}
export function getSocketServer() {
    if (!io)
        throw new Error('Socket.io server not initialized yet');
    return io;
}
//# sourceMappingURL=socket.js.map