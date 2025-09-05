import { WebSocket } from "ws";
import { v4 as uuidv4 } from "uuid";
import {
  AuthenticatedWebSocket,
  WebSocketMessage,
  WebSocketResponse,
  WebSocketEvent,
} from "../types/index";
import { authService } from "./auth";
import { mongodbStore } from "./mongodb-store";
import { sessionManager } from "./session-manager";
import { redisAdapter } from "./redis-adapter";

export class ClusteredWebSocketManager {
  private connections = new Map<string, AuthenticatedWebSocket>();
  private serverId: string;
  private documentSubscriptions = new Set<string>();

  constructor() {
    this.serverId = process.env.DYNO || process.pid.toString();
    this.initializeRedisSubscriptions();
  }

  private async initializeRedisSubscriptions() {
    // This will be called when documents are accessed
  }

  async handleConnection(ws: WebSocket) {
    const clientId = uuidv4();
    const authWs = ws as AuthenticatedWebSocket;
    authWs.clientId = clientId;
    authWs.authenticated = false;
    authWs.serverId = this.serverId;

    this.connections.set(clientId, authWs);

    console.log(`[${this.serverId}] New WebSocket connection: ${clientId}`);

    // Send handshake with server DID
    this.sendMessage(authWs, {
      status: true,
      statusCode: 200,
      seqId: null,
      is_handshake_response: true,
      data: {
        server_did: authService.getServerDid(),
        server_id: this.serverId,
        message: "Connected to collaboration server",
      },
    });

    authWs.on("message", async (data: Buffer) => {
      try {
        const message: WebSocketMessage = JSON.parse(data.toString());
        await this.handleMessage(authWs, message);
      } catch (error) {
        console.error(`[${this.serverId}] Error handling message from ${clientId}:`, error);
        this.sendError(authWs, null, "Invalid message format", 400);
      }
    });

    authWs.on("close", () => {
      this.handleDisconnection(clientId).catch((error) => {
        console.error(
          `[${this.serverId}] Error during disconnection cleanup for ${clientId}:`,
          error
        );
      });
    });

    authWs.on("error", (error) => {
      console.error(`[${this.serverId}] WebSocket error for ${clientId}:`, error);
      this.handleDisconnection(clientId).catch((error) => {
        console.error(
          `[${this.serverId}] Error during disconnection cleanup for ${clientId}:`,
          error
        );
      });
    });
  }

  private async handleMessage(ws: AuthenticatedWebSocket, message: WebSocketMessage) {
    const { event, args, seqId } = message;

    // Handle document subscription for clustering
    if (event === "join_document" && args.documentId) {
      await this.subscribeToDocument(args.documentId);
      await redisAdapter.trackConnection(args.documentId, ws.clientId!, this.serverId);
    }

    // Your existing message handling logic here...
    // Just add Redis broadcasting for relevant events
  }

  private async subscribeToDocument(documentId: string) {
    if (this.documentSubscriptions.has(documentId)) return;

    this.documentSubscriptions.add(documentId);

    await redisAdapter.subscribeToDocument(documentId, (event: WebSocketEvent) => {
      this.broadcastToLocalConnections(documentId, event);
    });
  }

  private broadcastToLocalConnections(documentId: string, event: WebSocketEvent) {
    // Broadcast only to local connections for this document
    Array.from(this.connections.values())
      .filter((ws) => ws.documentId === documentId && ws.authenticated)
      .forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(event));
        }
      });
  }

  // Enhanced broadcast that works across clusters
  async broadcastToDocument(documentId: string, event: WebSocketEvent, excludeClientId?: string) {
    // Broadcast to local connections
    Array.from(this.connections.values())
      .filter(
        (ws) => ws.documentId === documentId && ws.authenticated && ws.clientId !== excludeClientId
      )
      .forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(event));
        }
      });

    // Broadcast to other server instances via Redis
    await redisAdapter.broadcastEvent(documentId, event, this.serverId);
  }

  private async handleDisconnection(clientId: string) {
    const ws = this.connections.get(clientId);
    if (!ws) return;

    // Remove from Redis tracking
    if (ws.documentId) {
      await redisAdapter.untrackConnection(ws.documentId, clientId, this.serverId);
    }

    this.connections.delete(clientId);
    console.log(`[${this.serverId}] WebSocket disconnected: ${clientId}`);
  }

  private sendMessage(ws: AuthenticatedWebSocket, response: WebSocketResponse) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(response));
    }
  }

  private sendError(
    ws: AuthenticatedWebSocket,
    seqId: string | null,
    message: string,
    statusCode: number
  ) {
    this.sendMessage(ws, {
      status: false,
      statusCode,
      seqId,
      is_handshake_response: false,
      err: message,
    });
  }

  async getStats() {
    const localConnections = this.connections.size;
    const authenticatedConnections = Array.from(this.connections.values()).filter(
      (ws) => ws.authenticated
    ).length;

    return {
      serverId: this.serverId,
      localConnections,
      authenticatedConnections,
      documentSubscriptions: this.documentSubscriptions.size,
      runtimeSessions: sessionManager.activeSessionsCount,
      ...(await mongodbStore.getStats()),
    };
  }

  async shutdown() {
    console.log(`[${this.serverId}] Shutting down WebSocket manager...`);

    // Close all connections
    for (const ws of this.connections.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }

    // Unsubscribe from Redis
    for (const documentId of this.documentSubscriptions) {
      await redisAdapter.unsubscribeFromDocument(documentId);
    }

    this.connections.clear();
    this.documentSubscriptions.clear();
  }
}

export const clusteredWsManager = new ClusteredWebSocketManager();
