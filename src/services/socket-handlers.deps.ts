import type { AuthService } from "./auth";
import type { SessionManager } from "./session-manager";
import type { MongoDBStore } from "./mongodb-store";

export interface SocketHandlerDeps {
  authService: AuthService;
  sessionManager: SessionManager;
  mongodbStore: MongoDBStore;
}
