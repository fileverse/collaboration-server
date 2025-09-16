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

type BroadcastHandler = (
  sessionKey: string,
  message: any,
  excludeClientId?: string
) => Promise<void>;

export class SessionManager {
  private inMemorySessions = new Map<string, RuntimeSession>();
  private broadcastHandler?: BroadcastHandler;

  constructor() {
    this.setupRedisEventHandlers();
  }

  private getSessionKey(documentId: string, sessionDid: string): string {
    return `${documentId}__${sessionDid}`;
  }

  private setupRedisEventHandlers(): void {
    if (!redisStore.connected) return;

    // Handle session events from other dynos
    redisStore.onSessionEvent("SESSION_CREATED", async (event) => {
      const { sessionKey, data } = event;
      const runtimeSession: RuntimeSession = {
        documentId: data.documentId,
        sessionDid: data.sessionDid,
        ownerDid: data.ownerDid,
        clients: new Set(data.clients),
        roomInfo: data.roomInfo,
      };
      this.inMemorySessions.set(sessionKey, runtimeSession);
      console.log(`[SessionManager] Synced session creation: ${sessionKey}`);
    });

    redisStore.onSessionEvent("SESSION_UPDATED", async (event) => {
      const { sessionKey, data } = event;
      const existingSession = this.inMemorySessions.get(sessionKey);
      if (existingSession) {
        existingSession.clients = new Set(data.clients);
        existingSession.roomInfo = data.roomInfo;
        console.log(`[SessionManager] Synced session update: ${sessionKey}`);
      }
    });

    redisStore.onSessionEvent("SESSION_DELETED", async (event) => {
      const { sessionKey } = event;
      this.inMemorySessions.delete(sessionKey);
      console.log(`[SessionManager] Synced session deletion: ${sessionKey}`);
    });

    redisStore.onSessionEvent("CLIENT_JOINED", async (event) => {
      const { sessionKey, data } = event;
      const session = this.inMemorySessions.get(sessionKey);
      if (session) {
        session.clients.add(data.clientId);
        console.log(`[SessionManager] Synced client join: ${data.clientId} → ${sessionKey}`);
      }
    });

    redisStore.onSessionEvent("CLIENT_LEFT", async (event) => {
      const { sessionKey, data } = event;
      const session = this.inMemorySessions.get(sessionKey);
      if (session) {
        session.clients.delete(data.clientId);
        console.log(`[SessionManager] Synced client leave: ${data.clientId} ← ${sessionKey}`);
      }
    });

    redisStore.onSessionEvent("ROOM_INFO_UPDATED", async (event) => {
      const { sessionKey, data } = event;
      const session = this.inMemorySessions.get(sessionKey);
      if (session) {
        session.roomInfo = data.roomInfo;
        console.log(`[SessionManager] Synced room info: ${sessionKey}`);
      }
    });

    redisStore.onSessionEvent("BROADCAST_MESSAGE", async (event) => {
      const { sessionKey, data } = event;
      const { message, excludeClientId } = data;

      console.log(`[SessionManager] Broadcasting to local clients: ${sessionKey}`);
      // Get the broadcast handler if registered
      if (this.broadcastHandler) {
        await this.broadcastHandler(sessionKey, message, excludeClientId);
      }
    });
  }

  async createSession(sessionData: Omit<RuntimeSession, "clients">): Promise<RuntimeSession> {
    const runtimeSession: RuntimeSession = {
      ...sessionData,
      clients: new Set<string>(),
    };

    // Store in memory for immediate access
    const sessionKey = this.getSessionKey(sessionData.documentId, sessionData.sessionDid);
    this.inMemorySessions.set(sessionKey, runtimeSession);

    // Cache in Redis for fast access
    if (redisStore.connected) {
      await redisStore.setSession(sessionKey, {
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

  async getSession(documentId: string, sessionDid: string): Promise<RuntimeSession | undefined> {
    // Check in-memory first for active sessions
    const sessionKey = this.getSessionKey(documentId, sessionDid);
    let inMemorySession = this.inMemorySessions.get(sessionKey);
    if (inMemorySession) {
      return inMemorySession;
    }

    // Check Redis cache (fast)
    let cachedSession: any;
    if (redisStore.connected) {
      cachedSession = await redisStore.getSession(sessionKey);

      if (cachedSession) {
        const runtimeSession: RuntimeSession = {
          documentId: cachedSession.documentId,
          sessionDid: cachedSession.sessionDid,
          ownerDid: cachedSession.ownerDid,
          clients: new Set(cachedSession.clients),
          roomInfo: cachedSession.roomInfo,
        };

        // Store in memory for immediate access
        this.inMemorySessions.set(sessionKey, runtimeSession);
        return runtimeSession;
      }
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

    // Cache the session in Redis for future access
    if (redisStore.connected && !cachedSession) {
      await redisStore.setSession(sessionKey, {
        documentId: runtimeSession.documentId,
        sessionDid: runtimeSession.sessionDid,
        ownerDid: runtimeSession.ownerDid,
        clients: [],
        roomInfo: runtimeSession.roomInfo,
      });
    }

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
    // Get the session (this will check memory, Redis, and MongoDB in order)
    const session = await this.getSession(documentId, sessionDid);
    if (!session) return false;

    // Add to in-memory session
    session.clients.add(clientId);

    // Sync with Redis if connected
    if (redisStore.connected) {
      const sessionKey = this.getSessionKey(documentId, sessionDid);
      await redisStore.addClientToSession(sessionKey, clientId);
    }

    return true;
  }

  async removeClientFromSession(
    documentId: string,
    sessionDid: string,
    clientId: string
  ): Promise<void> {
    // Get in-memory session
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

    // Update Redis cache if connected
    if (redisStore.connected) {
      await redisStore.removeClientFromSession(sessionKey, clientId);
    }
  }

  async deactivateSession(documentId: string, sessionDid: string): Promise<void> {
    // Remove from in-memory storage
    const sessionKey = this.getSessionKey(documentId, sessionDid);
    this.inMemorySessions.delete(sessionKey);

    // Remove from Redis cache
    if (redisStore.connected) {
      await redisStore.deleteSession(sessionKey);
    }
  }

  async terminateSession(documentId: string, sessionDid: string): Promise<void> {
    // Remove from in-memory storage

    const sessionKey = this.getSessionKey(documentId, sessionDid);
    this.inMemorySessions.delete(sessionKey);

    // Remove from Redis cache
    if (redisStore.connected) {
      await redisStore.deleteSession(sessionKey);
    }

    // Update MongoDB
    try {
      await SessionModel.findOneAndUpdate(
        { documentId, sessionDid },
        {
          state: "terminated",
          roomInfo: null,
        }
      );

      await DocumentUpdateModel.deleteMany({ documentId, sessionDid });
      await DocumentCommitModel.deleteMany({ documentId, sessionDid });
    } catch (error) {
      console.error("Error terminating session in database:", error);
    }
  }

  async getActiveSessionsCount(): Promise<number> {
    // For multi-dyno deployment, always use Redis for accurate count
    if (redisStore.connected) {
      return await redisStore.getActiveSessionsCount();
    }

    // Use in-memory count as fallback
    const inMemoryCount = this.inMemorySessions.size;
    if (inMemoryCount > 0) {
      return inMemoryCount;
    }

    // Fallback to MongoDB count
    try {
      return await SessionModel.countDocuments({ state: "active" });
    } catch (error) {
      console.error("Error getting active sessions count from database:", error);
      return 0;
    }
  }

  async getGlobalClientList(documentId: string, sessionDid: string): Promise<Set<string>> {
    const sessionKey = this.getSessionKey(documentId, sessionDid);

    // Get clients from Redis (which has the global state)
    if (redisStore.connected) {
      const redisSession = await redisStore.getSession(sessionKey);
      if (redisSession) {
        return new Set(redisSession.clients);
      }
    }

    // Fallback to local session
    const localSession = this.inMemorySessions.get(sessionKey);
    return localSession ? localSession.clients : new Set<string>();
  }

  async updateRoomInfo(
    documentId: string,
    sessionDid: string,
    ownerDid: string,
    roomInfo: string
  ): Promise<void> {
    // Update in-memory session
    const sessionKey = this.getSessionKey(documentId, sessionDid);
    const session = this.inMemorySessions.get(sessionKey);
    if (session) {
      session.roomInfo = roomInfo;
    }

    // Update Redis cache
    if (redisStore.connected) {
      await redisStore.updateRoomInfo(sessionKey, roomInfo);
    }

    // Update MongoDB
    try {
      await SessionModel.findOneAndUpdate({ documentId, sessionDid, ownerDid }, { roomInfo });
    } catch (error) {
      console.error("Error updating session in database:", error);
    }
  }

  setBroadcastHandler(handler: BroadcastHandler): void {
    this.broadcastHandler = handler;
  }

  async broadcastToAllDynos(
    documentId: string,
    sessionDid: string,
    message: any,
    excludeClientId?: string
  ): Promise<void> {
    const sessionKey = this.getSessionKey(documentId, sessionDid);

    if (redisStore.connected) {
      await redisStore.publishBroadcastMessage(sessionKey, message, excludeClientId);
    }

    // Also handle local broadcasting immediately
    if (this.broadcastHandler) {
      await this.broadcastHandler(sessionKey, message, excludeClientId);
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
