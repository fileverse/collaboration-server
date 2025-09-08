import Redis from "ioredis";
import { config } from "../config";

interface CachedSession {
  documentId: string;
  sessionDid: string;
  ownerDid: string;
  clients: string[];
  roomInfo?: string;
}

interface SessionEvent {
  type:
    | "SESSION_CREATED"
    | "SESSION_UPDATED"
    | "SESSION_DELETED"
    | "CLIENT_JOINED"
    | "CLIENT_LEFT"
    | "ROOM_INFO_UPDATED"
    | "BROADCAST_MESSAGE";
  sessionKey: string;
  data: any;
  dynoId: string;
}

type SessionEventHandler = (event: SessionEvent) => Promise<void>;

export class RedisStore {
  private redis: Redis;
  private subscriber: Redis;
  private isConnected = false;
  private keyPrefix = "collab:";
  private sessionChannel = "session_events";
  private dynoId: string;
  private eventHandlers = new Map<string, SessionEventHandler>();

  constructor() {
    this.redis = new Redis(config.redis.url);
    this.subscriber = new Redis(config.redis.url);
    this.dynoId = `dyno_${Math.random().toString(36).substring(7)}_${Date.now()}`;
    this.isConnected = true; // Enable Redis for production
    this.setupEventHandlers();
    this.setupPubSub();
  }

  private setupEventHandlers(): void {
    this.redis.on("connect", () => {
      console.log(`Redis connected successfully - Dyno ID: ${this.dynoId}`);
      this.isConnected = true;
    });

    this.redis.on("error", (error: Error) => {
      console.error("Redis connection error:", error);
      this.isConnected = false;
    });

    this.redis.on("close", () => {
      console.log("Redis connection closed");
      this.isConnected = false;
    });

    this.subscriber.on("connect", () => {
      console.log("Redis subscriber connected successfully");
    });

    this.subscriber.on("error", (error: Error) => {
      console.error("Redis subscriber connection error:", error);
    });
  }

  private setupPubSub(): void {
    this.subscriber.subscribe(this.sessionChannel);
    console.log(`[${this.dynoId}] Subscribed to Redis pub/sub channel: ${this.sessionChannel}`);

    this.subscriber.on("message", async (channel: string, message: string) => {
      if (channel === this.sessionChannel) {
        try {
          const event: SessionEvent = JSON.parse(message);

          // Don't process events from our own dyno
          if (event.dynoId === this.dynoId) {
            return;
          }

          console.log(
            `[${this.dynoId}] Received ${event.type} from ${event.dynoId} for ${event.sessionKey}`
          );
          await this.handleSessionEvent(event);
        } catch (error) {
          console.error(`[${this.dynoId}] Error processing session event:`, error);
        }
      }
    });
  }

  private async publishSessionEvent(event: Omit<SessionEvent, "dynoId">): Promise<void> {
    if (!this.isConnected) return;

    try {
      const fullEvent: SessionEvent = {
        ...event,
        dynoId: this.dynoId,
      };

      await this.redis.publish(this.sessionChannel, JSON.stringify(fullEvent));
      console.log(`[${this.dynoId}] Published ${event.type} for ${event.sessionKey}`);
    } catch (error) {
      console.error(`[${this.dynoId}] Error publishing session event:`, error);
    }
  }

  private async handleSessionEvent(event: SessionEvent): Promise<void> {
    const handler = this.eventHandlers.get(event.type);
    if (handler) {
      await handler(event);
    }
  }

  public onSessionEvent(eventType: SessionEvent["type"], handler: SessionEventHandler): void {
    this.eventHandlers.set(eventType, handler);
  }

  async setSession(sessionKey: string, session: CachedSession, isUpdate = false): Promise<boolean> {
    if (!this.isConnected) return false;

    try {
      await this.redis.setex(
        `${this.keyPrefix}session:${sessionKey}`,
        86400, // 1 day TTL
        JSON.stringify(session)
      );

      // Publish event to other dynos
      await this.publishSessionEvent({
        type: isUpdate ? "SESSION_UPDATED" : "SESSION_CREATED",
        sessionKey,
        data: session,
      });

      return true;
    } catch (error) {
      console.error("Error setting session in Redis:", error);
      return false;
    }
  }

  async getSession(sessionKey: string): Promise<CachedSession | null> {
    if (!this.isConnected) return null;

    try {
      const data = await this.redis.get(`${this.keyPrefix}session:${sessionKey}`);
      if (!data) return null;

      const session: CachedSession = JSON.parse(data);
      return session;
    } catch (error) {
      console.error("Error getting session from Redis:", error);
      return null;
    }
  }

  async addClientToSession(sessionKey: string, clientId: string): Promise<boolean> {
    if (!this.isConnected) return false;

    try {
      const session = await this.getSession(sessionKey);
      if (!session) return false;

      if (!session.clients.includes(clientId)) {
        session.clients.push(clientId);
        await this.setSession(sessionKey, session, true);

        // Publish client joined event
        await this.publishSessionEvent({
          type: "CLIENT_JOINED",
          sessionKey,
          data: { clientId, session },
        });
      }
      return true;
    } catch (error) {
      console.error("Error adding client to session in Redis:", error);
      return false;
    }
  }

  async removeClientFromSession(sessionKey: string, clientId: string): Promise<boolean> {
    if (!this.isConnected) return false;

    try {
      const session = await this.getSession(sessionKey);
      if (!session) return false;

      session.clients = session.clients.filter((id) => id !== clientId);

      // Publish client left event
      await this.publishSessionEvent({
        type: "CLIENT_LEFT",
        sessionKey,
        data: { clientId, session },
      });

      if (session.clients.length === 0) {
        await this.deleteSession(sessionKey);
      } else {
        await this.setSession(sessionKey, session, true);
      }

      return true;
    } catch (error) {
      console.error("Error removing client from session in Redis:", error);
      return false;
    }
  }

  async deleteSession(sessionKey: string): Promise<boolean> {
    if (!this.isConnected) return false;

    try {
      await this.redis.del(`${this.keyPrefix}session:${sessionKey}`);

      // Publish session deleted event
      await this.publishSessionEvent({
        type: "SESSION_DELETED",
        sessionKey,
        data: { sessionKey },
      });

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

  async extendSessionTTL(sessionKey: string, ttlSeconds = 86400): Promise<boolean> {
    if (!this.isConnected) return false;

    try {
      await this.redis.expire(`${this.keyPrefix}session:${sessionKey}`, ttlSeconds);
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

  async updateRoomInfo(sessionKey: string, roomInfo: string): Promise<boolean> {
    if (!this.isConnected) return false;

    try {
      const session = await this.getSession(sessionKey);
      if (!session) return false;

      session.roomInfo = roomInfo;
      await this.setSession(sessionKey, session, true);

      // Publish room info updated event
      await this.publishSessionEvent({
        type: "ROOM_INFO_UPDATED",
        sessionKey,
        data: { roomInfo, session },
      });

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
      this.subscriber.disconnect();
    } catch (error) {
      console.error("Error disconnecting from Redis:", error);
    }
  }

  get dynoIdentifier(): string {
    return this.dynoId;
  }

  async publishBroadcastMessage(
    sessionKey: string,
    message: any,
    excludeClientId?: string
  ): Promise<void> {
    await this.publishSessionEvent({
      type: "BROADCAST_MESSAGE",
      sessionKey,
      data: { message, excludeClientId },
    });
  }
}

export const redisStore = new RedisStore();
