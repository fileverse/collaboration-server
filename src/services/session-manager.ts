import { SessionModel, DocumentUpdateModel, DocumentCommitModel } from "../database/models";

interface RuntimeSession {
  documentId: string;
  sessionDid: string;
  ownerDid: string;
  clients: Set<string>;
  roomInfo?: string;
  appType?: "ddoc" | "dsheet";
  ownerIdentityDid?: string;
  portalAddress?: string;
  collabJoinEnabled?: boolean;
  workspaceEditEnabled?: boolean;
}

export class SessionManager {
  private inMemorySessions = new Map<string, RuntimeSession>();
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    this.cleanupInterval = setInterval(() => this.cleanupIdleSessions(), 5 * 60 * 1000);
  }

  private cleanupIdleSessions() {
    for (const [key, session] of this.inMemorySessions) {
      if (session.clients.size === 0) {
        this.inMemorySessions.delete(key);
      }
    }
  }

  private getSessionKey(documentId: string, sessionDid: string): string {
    return `${documentId}__${sessionDid}`;
  }

  /**
   * Returns the local client set for a session, or undefined if not in memory.
   */
  getLocalClients(documentId: string, sessionDid: string): Set<string> | undefined {
    const key = this.getSessionKey(documentId, sessionDid);
    return this.inMemorySessions.get(key)?.clients;
  }

  async createSession(sessionData: Omit<RuntimeSession, "clients">): Promise<RuntimeSession> {
    const runtimeSession: RuntimeSession = {
      ...sessionData,
      clients: new Set<string>(),
    };

    // Store in memory for immediate access
    const sessionKey = this.getSessionKey(sessionData.documentId, sessionData.sessionDid);
    this.inMemorySessions.set(sessionKey, runtimeSession);

    // Persist in MongoDB for durability. Identity binding is first-writer-immutable:
    // written once via $setOnInsert and never overwritten by later calls.
    try {
      await SessionModel.findOneAndUpdate(
        { documentId: sessionData.documentId, sessionDid: sessionData.sessionDid },
        {
          $setOnInsert: {
            ownerDid: sessionData.ownerDid,
            ownerIdentityDid: sessionData.ownerIdentityDid ?? null,
            portalAddress: sessionData.portalAddress ?? null,
            collabJoinEnabled: sessionData.collabJoinEnabled ?? false,
          },
          $set: {
            state: "active",
            roomInfo: sessionData.roomInfo,
            appType: sessionData.appType ?? "ddoc",
          },
        },
        { upsert: true, new: true }
      );
    } catch (error) {
      console.error("Error persisting session:", error);
    }

    return runtimeSession;
  }

  // R3 heal: fill a session's ownerIdentityDid only when it is currently absent/empty.
  // The conditional filter makes this atomic and immutable-preserving — it never
  // overwrites a real binding, so concurrent callers race to a single first-proven fill.
  async fillOwnerIdentityDidIfAbsent(
    documentId: string,
    sessionDid: string,
    ownerIdentityDid: string
  ): Promise<void> {
    try {
      await SessionModel.updateOne(
        {
          documentId,
          sessionDid,
          $or: [
            { ownerIdentityDid: { $exists: false } },
            { ownerIdentityDid: null },
            { ownerIdentityDid: "" },
          ],
        },
        { $set: { ownerIdentityDid } }
      );
      const sessionKey = this.getSessionKey(documentId, sessionDid);
      const mem = this.inMemorySessions.get(sessionKey);
      if (mem && !mem.ownerIdentityDid) mem.ownerIdentityDid = ownerIdentityDid;
    } catch (error) {
      console.error("Error filling ownerIdentityDid:", error);
    }
  }

  // Rotation heal: the chain re-registered the portal collab DID (member
  // removal); adopt it so compares against the stored value keep working.
  async updateSessionOwnerDid(
    documentId: string,
    sessionDid: string,
    ownerDid: string
  ): Promise<void> {
    try {
      await SessionModel.updateOne({ documentId, sessionDid }, { $set: { ownerDid } });
      const sessionKey = this.getSessionKey(documentId, sessionDid);
      const mem = this.inMemorySessions.get(sessionKey);
      if (mem) mem.ownerDid = ownerDid;
    } catch (error) {
      console.error("Error updating session ownerDid:", error);
    }
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
      appType: dbSession.appType,
      ownerIdentityDid: dbSession.ownerIdentityDid ?? undefined,
      portalAddress: dbSession.portalAddress ?? undefined,
      collabJoinEnabled: dbSession.collabJoinEnabled,
      workspaceEditEnabled: dbSession.workspaceEditEnabled,
    };

    // Store in memory
    this.inMemorySessions.set(sessionKey, runtimeSession);

    return runtimeSession;
  }

  async getCollabJoinEnabled(documentId: string, sessionDid: string): Promise<boolean | undefined> {
    const doc = await SessionModel.findOne({ documentId, sessionDid }, { collabJoinEnabled: 1 }).lean();
    return (doc as any)?.collabJoinEnabled;
  }

  async setCollabJoinEnabled(documentId: string, sessionDid: string, enabled: boolean): Promise<boolean> {
    const sessionKey = this.getSessionKey(documentId, sessionDid);
    const session = this.inMemorySessions.get(sessionKey);
    if (session) session.collabJoinEnabled = enabled;
    try {
      const res = await SessionModel.findOneAndUpdate({ documentId, sessionDid }, { collabJoinEnabled: enabled });
      return res !== null || session !== undefined;
    } catch (error) {
      console.error("Error setting collabJoinEnabled:", error);
      return false;
    }
  }

  async getWorkspaceEditEnabled(documentId: string, sessionDid: string): Promise<boolean | undefined> {
    const doc = await SessionModel.findOne({ documentId, sessionDid }, { workspaceEditEnabled: 1 }).lean();
    return (doc as any)?.workspaceEditEnabled;
  }

  async setWorkspaceEditEnabled(documentId: string, sessionDid: string, enabled: boolean): Promise<boolean> {
    const sessionKey = this.getSessionKey(documentId, sessionDid);
    const session = this.inMemorySessions.get(sessionKey);
    if (session) session.workspaceEditEnabled = enabled;
    try {
      const res = await SessionModel.findOneAndUpdate({ documentId, sessionDid }, { workspaceEditEnabled: enabled });
      return res !== null || session !== undefined;
    } catch (error) {
      console.error("Error setting workspaceEditEnabled:", error);
      return false;
    }
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

    try {
      await SessionModel.findOneAndUpdate(
        { documentId, sessionDid },
        { state: "active" }
      );
    } catch (error) {
      console.error("Error reactivating session in database:", error);
    }

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

    try {
      await SessionModel.findOneAndUpdate(
        { documentId, sessionDid },
        { state: "inactive" }
      );
    } catch (error) {
      console.error("Error deactivating session in database:", error);
    }
  }

  async terminateSession(
    documentId: string,
    sessionDid: string,
    appType: "ddoc" | "dsheet" = "ddoc"
  ): Promise<void> {
    const sessionKey = this.getSessionKey(documentId, sessionDid);
    this.inMemorySessions.delete(sessionKey);

    try {
      await SessionModel.findOneAndUpdate(
        { documentId, sessionDid },
        { state: "terminated", roomInfo: null }
      );

      if (appType === "dsheet") {
        await DocumentUpdateModel.deleteMany({ documentId, sessionDid });
        await DocumentCommitModel.deleteMany({ documentId, sessionDid });
      }
    } catch (error) {
      console.error("Error terminating session in database:", error);
    }
  }

  // All non-terminated sessions for this owner's document except the caller's own. The
  // rotation path terminates these when a new session supersedes them; including INACTIVE
  // (not only active) sessions closes a forward-secrecy hole where an idled-out old-roomKey
  // session lingered `/auth`-able forever and was never GC'd.
  async getOtherNonTerminatedSessions(
    documentId: string,
    ownerDid: string,
    portalAddress: string | null,
    excludeSessionDid?: string
  ): Promise<Array<{ documentId: string; sessionDid: string; appType?: "ddoc" | "dsheet" }>> {
    try {
      const or: Record<string, any>[] = [{ ownerDid }];
      if (portalAddress && /^0x[0-9a-fA-F]{40}$/.test(portalAddress)) {
        // Post-rotation sessions store the old ownerDid — the portal match is
        // what lets a new-DID owner sweep them.
        or.push({ portalAddress: { $regex: `^${portalAddress}$`, $options: "i" } });
      }
      const query: Record<string, any> = { documentId, state: { $ne: "terminated" }, $or: or };
      if (excludeSessionDid) {
        query.sessionDid = { $ne: excludeSessionDid };
      }
      const sessions = await SessionModel.find(query);
      return sessions.map((s) => ({
        documentId: s.documentId,
        sessionDid: s.sessionDid,
        appType: s.appType,
      }));
    } catch (error) {
      console.error("Error getting other non-terminated sessions:", error);
      return [];
    }
  }

  // Every non-terminated session for a document, regardless of owner. Stop-share uses this
  // to close the collab-join flag and drop live non-owner sockets across ALL of a doc's
  // rooms — a stale client-supplied sessionDid must not leave the current room open.
  async getNonTerminatedSessionsForDocument(
    documentId: string
  ): Promise<Array<{ sessionDid: string }>> {
    try {
      const sessions = await SessionModel.find(
        { documentId, state: { $ne: "terminated" } },
        { sessionDid: 1 }
      ).lean();
      return sessions.map((s: any) => ({ sessionDid: s.sessionDid }));
    } catch (error) {
      console.error("Error getting non-terminated sessions for document:", error);
      return [];
    }
  }

  async getNonTerminatedSessionsForPortal(
    portalAddress: string
  ): Promise<Array<{ documentId: string; sessionDid: string }>> {
    if (!/^0x[0-9a-fA-F]{40}$/.test(portalAddress)) return [];
    try {
      const sessions = await SessionModel.find(
        {
          portalAddress: { $regex: `^${portalAddress}$`, $options: "i" },
          state: { $ne: "terminated" },
        },
        { documentId: 1, sessionDid: 1 }
      ).lean();
      return sessions.map((s: any) => ({
        documentId: s.documentId,
        sessionDid: s.sessionDid,
      }));
    } catch (error) {
      console.error("Error getting non-terminated sessions for portal:", error);
      return [];
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
    clearInterval(this.cleanupInterval);
    this.inMemorySessions.clear();
  }
}

export const sessionManager = new SessionManager();
