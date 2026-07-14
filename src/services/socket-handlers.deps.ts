import type { AuthService } from "./auth";
import type { SessionManager } from "./session-manager";
import type { MongoDBStore } from "./mongodb-store";
import type { GateEpochCache } from "./gate-epoch";

export interface SocketHandlerDeps {
  authService: AuthService;
  sessionManager: SessionManager;
  mongodbStore: MongoDBStore;
  gateEpochCache: GateEpochCache;
}
