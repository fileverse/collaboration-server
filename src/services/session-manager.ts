import { SessionModel, DocumentUpdateModel, DocumentCommitModel } from "../database/models";

interface RuntimeSession {
  documentId: string;
  sessionDid: string;
  ownerDid: string;
  clients: Set<string>;
  roomInfo?: string;
}

export class SessionManager {
  private inMemorySessions = new Map<string, RuntimeSession>();

  private getSessionKey(documentId: string, sessionDid: string): string {
    return `${documentId}__${sessionDid}`;
  }

  async createSession(sessionData: Omit<RuntimeSession, "clients">): Promise<RuntimeSession> {
    const runtimeSession: RuntimeSession = {
      ...sessionData,
      clients: new Set<string>(),
    };

    // Store in memory for immediate access
    const sessionKey = this.getSessionKey(sessionData.documentId, sessionData.sessionDid);
    this.inMemorySessions.set(sessionKey, runtimeSession);

    // Persist in MongoDB for durability
    try {
      await SessionModel.findOneAndUpdate(
        {
          documentId: sessionData.documentId,
          sessionDid: sessionData.sessionDid,
          ownerDid: sessionData.ownerDid,
        },
        { state: "active", roomInfo: sessionData.roomInfo },
        { upsert: true, new: true }
      );
    } catch (error) {
      console.error("Error persisting session:", error);
    }

    return runtimeSession;
  }

  async getSession(documentId: string, sessionDid: string): Promise<RuntimeSession | undefined> {
    // Check in-memory first for active sessions
    const sessionKey = this.getSessionKey(documentId, sessionDid);
    let inMemorySession = this.inMemorySessions.get(sessionKey);
    if (inMemorySession) {
      return inMemorySession;
    }

    // Fallback to MongoDB (persistent storage)
    const dbSession = await SessionModel.findOne({
      documentId,
      sessionDid,
      state: { $ne: "terminated" },
    });
    if (!dbSession) return undefined;

    const runtimeSession: RuntimeSession = {
      documentId: dbSession.documentId,
      sessionDid: dbSession.sessionDid,
      ownerDid: dbSession.ownerDid,
      clients: new Set<string>(),
      roomInfo: dbSession.roomInfo,
    };

    // Store in memory
    this.inMemorySessions.set(sessionKey, runtimeSession);

    return runtimeSession;
  }

  async getRuntimeSession(
    documentId: string,
    sessionDid: string
  ): Promise<RuntimeSession | undefined> {
    return this.getSession(documentId, sessionDid);
  }

  async addClientToSession(
    documentId: string,
    sessionDid: string,
    clientId: string
  ): Promise<boolean> {
    const session = await this.getSession(documentId, sessionDid);
    if (!session) return false;

    session.clients.add(clientId);
    return true;
  }

  async removeClientFromSession(
    documentId: string,
    sessionDid: string,
    clientId: string
  ): Promise<void> {
    const sessionKey = this.getSessionKey(documentId, sessionDid);
    const session = this.inMemorySessions.get(sessionKey);
    if (session) {
      session.clients.delete(clientId);

      // If no more clients, deactivate the session
      if (session.clients.size === 0) {
        await this.deactivateSession(documentId, sessionDid);
        return;
      }
    }
  }

  async deactivateSession(documentId: string, sessionDid: string): Promise<void> {
    const sessionKey = this.getSessionKey(documentId, sessionDid);
    this.inMemorySessions.delete(sessionKey);
  }

  async terminateSession(documentId: string, sessionDid: string): Promise<void> {
    const sessionKey = this.getSessionKey(documentId, sessionDid);
    this.inMemorySessions.delete(sessionKey);

    try {
      await SessionModel.findOneAndUpdate(
        { documentId, sessionDid },
        { state: "terminated", roomInfo: null }
      );

      await DocumentUpdateModel.deleteMany({ documentId, sessionDid });
      await DocumentCommitModel.deleteMany({ documentId, sessionDid });
    } catch (error) {
      console.error("Error terminating session in database:", error);
    }
  }

  async terminateOtherExistingSessions(documentId: string, ownerDid: string): Promise<void> {
    try {
      const existingSessions = await SessionModel.find({ documentId, ownerDid, state: "active" });
      for (const session of existingSessions) {
        await this.terminateSession(documentId, session.sessionDid);
        console.log(
          `[SessionManager] Terminated session: ${session.sessionDid} for document: ${documentId}`
        );
      }
    } catch (error) {
      console.error("Error terminating existing sessions:", error);
    }
  }

  async getActiveSessionsCount(): Promise<number> {
    const inMemoryCount = this.inMemorySessions.size;
    if (inMemoryCount > 0) {
      return inMemoryCount;
    }

    try {
      return await SessionModel.countDocuments({ state: "active" });
    } catch (error) {
      console.error("Error getting active sessions count from database:", error);
      return 0;
    }
  }

  async updateRoomInfo(
    documentId: string,
    sessionDid: string,
    ownerDid: string,
    roomInfo: string
  ): Promise<void> {
    const sessionKey = this.getSessionKey(documentId, sessionDid);
    const session = this.inMemorySessions.get(sessionKey);
    if (session) {
      session.roomInfo = roomInfo;
    }

    try {
      await SessionModel.findOneAndUpdate({ documentId, sessionDid, ownerDid }, { roomInfo });
    } catch (error) {
      console.error("Error updating session in database:", error);
    }
  }

  async destroy(): Promise<void> {
    this.inMemorySessions.clear();
  }
}

export const sessionManager = new SessionManager();