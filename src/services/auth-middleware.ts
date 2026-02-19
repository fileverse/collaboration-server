import { AppSocket } from "../types/index";

export function authMiddleware(socket: AppSocket, next: (err?: Error) => void): void {
  // Actual UCAN verification happens in the "/auth" event handler
  socket.data.authenticated = false;
  socket.data.documentId = "";
  socket.data.sessionDid = "";
  socket.data.role = "editor";

  next();
}

export function requireAuth(socket: AppSocket): boolean {
  return socket.data.authenticated === true && !!socket.data.documentId && !!socket.data.sessionDid;
}