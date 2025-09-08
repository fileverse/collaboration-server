import Redis from "ioredis";
import { config } from "../config";

interface CachedSession {
  documentId: string;
  sessionDid: string;
  ownerDid: string;
  clients: string[];
  roomInfo?: string;
}

export class RedisStore {
  private redis: Redis;
  private isConnected = false;
  private keyPrefix = "collab:";

  constructor() {
    // Redis integration disabled - keeping file for potential future use
    this.redis = new Redis(config.redis.url);
    this.isConnected = false; // Force disconnected state
    // this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.redis.on("connect", () => {
      console.log("Redis connected successfully");

      this.isConnected = true;
      // Clear sessions in development mode
      // if (process.env.NODE_ENV === "development") {
      //   this.clearAllSessions();
      // }
    });

    this.redis.on("error", (error: Error) => {
      console.error("Redis connection error:", error);
      this.isConnected = false;
    });

    this.redis.on("close", () => {
      console.log("Redis connection closed");
      this.isConnected = false;
    });
  }

  async setSession(documentId: string, session: CachedSession): Promise<boolean> {
    if (!this.isConnected) return false;

    try {
      await this.redis.setex(
        `${this.keyPrefix}session:${documentId}`,
        86400, // 1 day TTL
        JSON.stringify(session)
      );
      return true;
    } catch (error) {
      console.error("Error setting session in Redis:", error);
      return false;
    }
  }

  async getSession(documentId: string): Promise<CachedSession | null> {
    if (!this.isConnected) return null;

    try {
      const data = await this.redis.get(`${this.keyPrefix}session:${documentId}`);
      if (!data) return null;

      const session: CachedSession = JSON.parse(data);
      return session;
    } catch (error) {
      console.error("Error getting session from Redis:", error);
      return null;
    }
  }

  async addClientToSession(documentId: string, clientId: string): Promise<boolean> {
    if (!this.isConnected) return false;

    try {
      const session = await this.getSession(documentId);
      if (!session) return false;

      if (!session.clients.includes(clientId)) {
        session.clients.push(clientId);
        await this.setSession(documentId, session);
      }
      return true;
    } catch (error) {
      console.error("Error adding client to session in Redis:", error);
      return false;
    }
  }

  async removeClientFromSession(documentId: string, clientId: string): Promise<boolean> {
    if (!this.isConnected) return false;

    try {
      const session = await this.getSession(documentId);
      if (!session) return false;

      session.clients = session.clients.filter((id) => id !== clientId);

      if (session.clients.length === 0) {
        await this.deleteSession(documentId);
      } else {
        await this.setSession(documentId, session);
      }

      return true;
    } catch (error) {
      console.error("Error removing client from session in Redis:", error);
      return false;
    }
  }

  async deleteSession(documentId: string): Promise<boolean> {
    if (!this.isConnected) return false;

    try {
      await this.redis.del(`${this.keyPrefix}session:${documentId}`);
      return true;
    } catch (error) {
      console.error("Error deleting session from Redis:", error);
      return false;
    }
  }

  async getActiveSessionsCount(): Promise<number> {
    if (!this.isConnected) return 0;

    try {
      const keys = await this.redis.keys(`${this.keyPrefix}session:*`);
      return keys.length;
    } catch (error) {
      console.error("Error getting active sessions count from Redis:", error);
      return 0;
    }
  }

  async getAllActiveSessions(): Promise<string[]> {
    if (!this.isConnected) return [];

    try {
      const keys = await this.redis.keys(`${this.keyPrefix}session:*`);
      return keys.map((key: string) => key.replace(`${this.keyPrefix}session:`, ""));
    } catch (error) {
      console.error("Error getting all active sessions from Redis:", error);
      return [];
    }
  }

  async extendSessionTTL(documentId: string, ttlSeconds = 86400): Promise<boolean> {
    if (!this.isConnected) return false;

    try {
      await this.redis.expire(`${this.keyPrefix}session:${documentId}`, ttlSeconds);
      return true;
    } catch (error) {
      console.error("Error extending session TTL in Redis:", error);
      return false;
    }
  }

  async clearAllSessions(): Promise<boolean> {
    if (!this.isConnected) return false;

    try {
      const keys = await this.redis.keys(`${this.keyPrefix}session:*`);
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
      console.log(`cleared ${keys.length} sessions from Redis`);
      return true;
    } catch (error) {
      console.error("Error clearing all sessions from Redis:", error);
      return false;
    }
  }

  async updateRoomInfo(documentId: string, roomInfo: string): Promise<boolean> {
    if (!this.isConnected) return false;

    try {
      const session = await this.getSession(documentId);
      if (!session) return false;

      session.roomInfo = roomInfo;
      await this.setSession(documentId, session);
      return true;
    } catch (error) {
      console.error("Error updating room info in Redis:", error);
      return false;
    }
  }

  get connected(): boolean {
    return this.isConnected;
  }

  async disconnect(): Promise<void> {
    try {
      this.redis.disconnect();
    } catch (error) {
      console.error("Error disconnecting from Redis:", error);
    }
  }
}

export const redisStore = new RedisStore();
