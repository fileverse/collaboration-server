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
  constructor() {}

  async createSession(sessionData: Omit<RuntimeSession, "clients">): Promise<RuntimeSession> {
    const runtimeSession: RuntimeSession = {
      ...sessionData,
      clients: new Set<string>(),
    };

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
    // Check Redis cache first (fast)
    let cachedSession: any;
    if (redisStore.connected) {
      cachedSession = await redisStore.getSession(documentId);

      if (cachedSession) {
        return {
          documentId: cachedSession.documentId,
          sessionDid: cachedSession.sessionDid,
          ownerDid: cachedSession.ownerDid,
          clients: new Set(cachedSession.clients),
          roomInfo: cachedSession.roomInfo,
        };
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

    // Cache the session in Redis for future access
    if (!cachedSession) {
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
    // Check if session exists in Redis first
    if (redisStore.connected) {
      return await redisStore.addClientToSession(documentId, clientId);
    }

    // Fallback: check if session exists in MongoDB
    const dbSession = await SessionModel.findOne({ documentId, state: { $ne: "terminated" } });
    return !!dbSession;
  }

  async removeClientFromSession(documentId: string, clientId: string): Promise<void> {
    // Update Redis cache and check if session should be deactivated
    if (redisStore.connected) {
      const success = await redisStore.removeClientFromSession(documentId, clientId);
      if (!success) {
        // Session might have been auto-deactivated by Redis store
        return;
      }

      // Check if there are any clients left
      const session = await redisStore.getSession(documentId);
      if (!session || session.clients.length === 0) {
        await this.deactivateSession(documentId);
      }
    } else {
      // If Redis is not available, just deactivate the session
      await this.deactivateSession(documentId);
    }
  }

  async deactivateSession(documentId: string): Promise<void> {
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
    // Try Redis first for distributed count
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
    if (redisStore.connected) {
      await redisStore.updateRoomInfo(documentId, roomInfo);
    }
    try {
      await SessionModel.findOneAndUpdate({ documentId, sessionDid, ownerDid }, { roomInfo });
    } catch (error) {
      console.error("Error updating session in database:", error);
    }
  }

  async destroy(): Promise<void> {
    // Disconnect from Redis
    if (redisStore.connected) {
      await redisStore.disconnect();
    }
  }
}

export const sessionManager = new SessionManager();
