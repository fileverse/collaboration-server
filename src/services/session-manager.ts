import {
  SessionModel,
  ISession,
  DocumentUpdateModel,
  DocumentCommitModel,
} from "../database/models";
import { redisStore } from "./redis-store";

interface RuntimeSession {
  documentId: string;
  sessionDid: string;
  ownerDid: string;
  clients: Set<string>;
  roomInfo?: string;
}

export class SessionManager {
  private inMemorySessions = new Map<string, RuntimeSession>();

  constructor() {}

  async createSession(sessionData: Omit<RuntimeSession, "clients">): Promise<RuntimeSession> {
    const runtimeSession: RuntimeSession = {
      ...sessionData,
      clients: new Set<string>(),
    };

    // Store in memory for immediate access
    this.inMemorySessions.set(sessionData.documentId, runtimeSession);

    // Cache in Redis for fast access
    if (redisStore.connected) {
      await redisStore.setSession(sessionData.documentId, {
        documentId: sessionData.documentId,
        sessionDid: sessionData.sessionDid,
        ownerDid: sessionData.ownerDid,
        clients: [],
        roomInfo: sessionData.roomInfo,
      });
    }

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

  async getSession(documentId: string): Promise<RuntimeSession | undefined> {
    // Check in-memory first for active sessions
    let inMemorySession = this.inMemorySessions.get(documentId);
    if (inMemorySession) {
      return inMemorySession;
    }

    // Check Redis cache (fast)
    let cachedSession: any;
    if (redisStore.connected) {
      cachedSession = await redisStore.getSession(documentId);

      if (cachedSession) {
        const runtimeSession: RuntimeSession = {
          documentId: cachedSession.documentId,
          sessionDid: cachedSession.sessionDid,
          ownerDid: cachedSession.ownerDid,
          clients: new Set(cachedSession.clients),
          roomInfo: cachedSession.roomInfo,
        };

        // Store in memory for immediate access
        this.inMemorySessions.set(documentId, runtimeSession);
        return runtimeSession;
      }
    }

    // Fallback to MongoDB (persistent storage)
    const dbSession = await SessionModel.findOne({ documentId, state: { $ne: "terminated" } });
    if (!dbSession) return undefined;

    const runtimeSession: RuntimeSession = {
      documentId: dbSession.documentId,
      sessionDid: dbSession.sessionDid,
      ownerDid: dbSession.ownerDid,
      clients: new Set<string>(),
      roomInfo: dbSession.roomInfo,
    };

    // Store in memory
    this.inMemorySessions.set(documentId, runtimeSession);

    // Cache the session in Redis for future access
    if (redisStore.connected && !cachedSession) {
      await redisStore.setSession(documentId, {
        documentId: runtimeSession.documentId,
        sessionDid: runtimeSession.sessionDid,
        ownerDid: runtimeSession.ownerDid,
        clients: [],
        roomInfo: runtimeSession.roomInfo,
      });
    }

    return runtimeSession;
  }

  async getRuntimeSession(documentId: string): Promise<RuntimeSession | undefined> {
    return this.getSession(documentId);
  }

  async addClientToSession(documentId: string, clientId: string): Promise<boolean> {
    // Get the session (this will check memory, Redis, and MongoDB in order)
    const session = await this.getSession(documentId);
    if (!session) return false;

    // Add to in-memory session
    session.clients.add(clientId);

    // Sync with Redis if connected
    if (redisStore.connected) {
      await redisStore.addClientToSession(documentId, clientId);
    }

    return true;
  }

  async removeClientFromSession(documentId: string, clientId: string): Promise<void> {
    // Get in-memory session
    const session = this.inMemorySessions.get(documentId);
    if (session) {
      session.clients.delete(clientId);

      // If no more clients, deactivate the session
      if (session.clients.size === 0) {
        await this.deactivateSession(documentId);
        return;
      }
    }

    // Update Redis cache if connected
    if (redisStore.connected) {
      await redisStore.removeClientFromSession(documentId, clientId);
    }
  }

  async deactivateSession(documentId: string): Promise<void> {
    // Remove from in-memory storage
    this.inMemorySessions.delete(documentId);

    // Remove from Redis cache
    if (redisStore.connected) {
      await redisStore.deleteSession(documentId);
    }

    // Update MongoDB
    try {
      await SessionModel.findOneAndUpdate({ documentId }, { state: "inactive" });
    } catch (error) {
      console.error("Error deactivating session in database:", error);
    }
  }

  async terminateSession(documentId: string, sessionDid: string): Promise<void> {
    // Remove from in-memory storage
    this.inMemorySessions.delete(documentId);

    // Remove from Redis cache
    if (redisStore.connected) {
      await redisStore.deleteSession(documentId);
    }

    // Update MongoDB
    try {
      await SessionModel.findOneAndUpdate({ documentId, sessionDid }, { state: "terminated" });
      await DocumentUpdateModel.deleteMany({ documentId, sessionDid });
      await DocumentCommitModel.deleteMany({ documentId, sessionDid });
    } catch (error) {
      console.error("Error terminating session in database:", error);
    }
  }

  async getActiveSessionsCount(): Promise<number> {
    // Use in-memory count for most accurate real-time count
    const inMemoryCount = this.inMemorySessions.size;

    // If we have in-memory sessions, use that count
    if (inMemoryCount > 0) {
      return inMemoryCount;
    }

    // Try Redis for distributed count
    if (redisStore.connected) {
      return await redisStore.getActiveSessionsCount();
    }

    // Fallback to MongoDB count
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
    // Update in-memory session
    const session = this.inMemorySessions.get(documentId);
    if (session) {
      session.roomInfo = roomInfo;
    }

    // Update Redis cache
    if (redisStore.connected) {
      await redisStore.updateRoomInfo(documentId, roomInfo);
    }

    // Update MongoDB
    try {
      await SessionModel.findOneAndUpdate({ documentId, sessionDid, ownerDid }, { roomInfo });
    } catch (error) {
      console.error("Error updating session in database:", error);
    }
  }

  async destroy(): Promise<void> {
    // Clear in-memory sessions
    this.inMemorySessions.clear();

    // Disconnect from Redis
    if (redisStore.connected) {
      await redisStore.disconnect();
    }
  }
}

export const sessionManager = new SessionManager();
