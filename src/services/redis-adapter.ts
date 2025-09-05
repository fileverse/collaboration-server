import { createClient, RedisClientType } from "redis";
import { config } from "../config";

export class RedisAdapter {
  private publisher: RedisClientType;
  private subscriber: RedisClientType;
  private isConnected = false;

  constructor() {
    const redisUrl = config.redisURL;

    this.publisher = createClient({ url: redisUrl });
    this.subscriber = createClient({ url: redisUrl });

    this.publisher.on("error", (err: Error) => console.error("Redis Publisher Error:", err));
    this.subscriber.on("error", (err: Error) => console.error("Redis Subscriber Error:", err));
  }

  async connect(): Promise<void> {
    if (this.isConnected) return;

    try {
      await Promise.all([this.publisher.connect(), this.subscriber.connect()]);

      this.isConnected = true;
      console.log("✅ Redis adapter connected");
    } catch (error) {
      console.error("❌ Redis connection failed:", error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.isConnected) return;

    await Promise.all([this.publisher.disconnect(), this.subscriber.disconnect()]);

    this.isConnected = false;
    console.log("Redis adapter disconnected");
  }

  // Broadcast WebSocket events across all instances
  async broadcastEvent(documentId: string, event: any, excludeServerId?: string): Promise<void> {
    const message = {
      documentId,
      event,
      excludeServerId,
      serverId: process.env.DYNO || process.pid.toString(),
      timestamp: Date.now(),
    };

    await this.publisher.publish(`doc:${documentId}`, JSON.stringify(message));
  }

  // Subscribe to document events
  async subscribeToDocument(documentId: string, callback: (event: any) => void): Promise<void> {
    await this.subscriber.subscribe(`doc:${documentId}`, (message: string) => {
      try {
        const data = JSON.parse(message);
        const currentServerId = process.env.DYNO || process.pid.toString();

        // Don't process events from the same server instance
        if (data.serverId !== currentServerId) {
          callback(data.event);
        }
      } catch (error) {
        console.error("Error parsing Redis message:", error);
      }
    });
  }

  async unsubscribeFromDocument(documentId: string): Promise<void> {
    await this.subscriber.unsubscribe(`doc:${documentId}`);
  }

  // Session management across instances
  async setSessionData(sessionId: string, data: any, ttlSeconds: number = 3600): Promise<void> {
    await this.publisher.setEx(`session:${sessionId}`, ttlSeconds, JSON.stringify(data));
  }

  async getSessionData(sessionId: string): Promise<any | null> {
    const data = await this.publisher.get(`session:${sessionId}`);
    return data ? JSON.parse(data) : null;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.publisher.del(`session:${sessionId}`);
  }

  // Connection tracking across instances
  async trackConnection(documentId: string, clientId: string, serverId: string): Promise<void> {
    await this.publisher.sAdd(`doc:${documentId}:connections`, `${serverId}:${clientId}`);
  }

  async untrackConnection(documentId: string, clientId: string, serverId: string): Promise<void> {
    await this.publisher.sRem(`doc:${documentId}:connections`, `${serverId}:${clientId}`);
  }

  async getDocumentConnections(documentId: string): Promise<string[]> {
    return await this.publisher.sMembers(`doc:${documentId}:connections`);
  }
}

export const redisAdapter = new RedisAdapter();
