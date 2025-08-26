import { SessionModel, ISession } from "../database/models";

interface RuntimeSession {
  documentId: string;
  collaborationDid: string;
  ownerDid: string;
  clients: Set<string>;
}

export class SessionManager {
  private sessions = new Map<string, RuntimeSession>();

  constructor() {}

  async createSession(sessionData: Omit<RuntimeSession, "clients">): Promise<RuntimeSession> {
    const runtimeSession: RuntimeSession = {
      ...sessionData,
      clients: new Set<string>(),
    };

    this.sessions.set(sessionData.documentId, runtimeSession);

    try {
      await SessionModel.findOneAndUpdate(
        {
          documentId: sessionData.documentId,
          collaborationDid: sessionData.collaborationDid,
          ownerDid: sessionData.ownerDid,
        },
        { state: "active" },
        { upsert: true, new: true }
      );
    } catch (error) {
      console.error("Error persisting session:", error);
    }

    return runtimeSession;
  }

  async getSession(documentId: string): Promise<RuntimeSession | undefined> {
    const session = this.sessions.get(documentId);
    if (session) return session;

    const dbSession = await SessionModel.findOne({ documentId, state: { $ne: "terminated" } });
    if (!dbSession) return undefined;

    const runtimeSession: RuntimeSession = {
      documentId: dbSession.documentId,
      collaborationDid: dbSession.collaborationDid,
      ownerDid: dbSession.ownerDid,
      clients: new Set<string>(),
    };

    this.sessions.set(documentId, runtimeSession);
    return runtimeSession;
  }

  getRuntimeSession(documentId: string): RuntimeSession | undefined {
    return this.sessions.get(documentId);
  }

  addClientToSession(documentId: string, clientId: string): boolean {
    const session = this.sessions.get(documentId);
    if (!session) return false;

    session.clients.add(clientId);
    return true;
  }

  async removeClientFromSession(documentId: string, clientId: string): Promise<void> {
    const session = this.sessions.get(documentId);
    if (!session) return;

    session.clients.delete(clientId);

    if (session.clients.size === 0) {
      await this.deactivateSession(documentId);
    }
  }

  async deactivateSession(documentId: string): Promise<void> {
    this.sessions.delete(documentId);
    try {
      await SessionModel.findOneAndUpdate({ documentId }, { state: "inactive" });
    } catch (error) {
      console.error("Error deactivating session in database:", error);
    }
  }

  async terminateSession(documentId: string): Promise<void> {
    this.sessions.delete(documentId);

    try {
      await SessionModel.findOneAndUpdate({ documentId }, { state: "terminated" });
    } catch (error) {
      console.error("Error terminating session in database:", error);
    }
  }

  get activeSessionsCount(): number {
    return this.sessions.size;
  }

  destroy(): void {
    // Cleanup logic can be added here if needed in the future
  }
}

export const sessionManager = new SessionManager();
