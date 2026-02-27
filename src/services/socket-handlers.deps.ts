import type { AuthService } from "./auth";
import type { SessionManager } from "./session-manager";

export interface SocketHandlerDeps {
  authService: AuthService;
  sessionManager: SessionManager;
}

