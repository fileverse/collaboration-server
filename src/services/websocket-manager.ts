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
import { SessionModel } from "../database/models";

export class WebSocketManager {
  private connections = new Map<string, AuthenticatedWebSocket>();

  constructor() {
    this.handleConnection = this.handleConnection.bind(this);
    this.setupSessionBroadcastHandler();
  }

  private setupSessionBroadcastHandler(): void {
    // Set up the broadcast handler for cross-dyno communication
    sessionManager.setBroadcastHandler(
      async (sessionKey: string, message: any, excludeClientId?: string) => {
        await this.handleCrossDynoBroadcast(sessionKey, message, excludeClientId);
      }
    );
  }

  private async handleCrossDynoBroadcast(
    sessionKey: string,
    message: any,
    excludeClientId?: string
  ): Promise<void> {
    const localSession = sessionManager["inMemorySessions"].get(sessionKey);
    if (!localSession) return;

    const messageStr = JSON.stringify(message);

    // Broadcast to clients connected to this dyno only
    localSession.clients.forEach((clientId: string) => {
      if (clientId === excludeClientId) return;

      const ws = this.connections.get(clientId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(messageStr);
      }
    });
  }

  handleConnection(ws: WebSocket) {
    const clientId = uuidv4();
    const authWs = ws as AuthenticatedWebSocket;
    authWs.clientId = clientId;
    authWs.authenticated = false;

    this.connections.set(clientId, authWs);

    console.log(`New WebSocket connection: ${clientId}`);

    // Send handshake with server DID
    this.sendMessage(authWs, {
      status: true,
      statusCode: 200,
      seqId: null,
      is_handshake_response: true,
      data: {
        server_did: authService.getServerDid(),
        message: "Connected to collaboration server",
      },
    });

    authWs.on("message", async (data: Buffer) => {
      try {
        const message: WebSocketMessage = JSON.parse(data.toString());
        await this.handleMessage(authWs, message);
      } catch (error) {
        console.error(`Error handling message from ${clientId}:`, error);
        this.sendError(authWs, null, "Invalid message format", 400);
      }
    });

    authWs.on("close", () => {
      this.handleDisconnection(clientId).catch((error) => {
        console.error(`Error during disconnection cleanup for ${clientId}:`, error);
      });
    });

    authWs.on("error", (error) => {
      console.error(`WebSocket error for ${clientId}:`, error);
      this.handleDisconnection(clientId).catch((error) => {
        console.error(`Error during disconnection cleanup for ${clientId}:`, error);
      });
    });
  }

  private async handleMessage(ws: AuthenticatedWebSocket, message: WebSocketMessage) {
    const { cmd, args, seqId } = message;

    try {
      switch (cmd) {
        case "/auth":
          await this.handleAuth(ws, args, seqId);
          break;

        case "/documents/update": {
          await this.handleDocumentUpdate(ws, args, seqId);
          break;
        }
        case "/documents/commit":
          await this.handleDocumentCommit(ws, args, seqId);
          break;
        case "/documents/commit/history":
          await this.handleCommitHistory(ws, args, seqId);
          break;
        case "/documents/update/history":
          await this.handleUpdateHistory(ws, args, seqId);
          break;
        case "/documents/peers/list":
          await this.handlePeersList(ws, args, seqId);
          break;
        case "/documents/awareness":
          await this.handleAwareness(ws, args, seqId);
          break;
        case "/documents/terminate":
          await this.handleTerminateSession(ws, args, seqId);
          break;
        default:
          this.sendError(ws, seqId, `Unknown command: ${cmd}`, 404);
      }
    } catch (error) {
      console.error(`Error handling command ${cmd}:`, error);
      this.sendError(ws, seqId, "Internal server error", 500);
    }
  }

  private async handleTerminateSession(ws: AuthenticatedWebSocket, args: any, seqId: string) {
    const { documentId, ownerToken, ownerAddress, contractAddress, sessionDid } = args;
    console.log("TERMINATING SESSION", documentId);

    if (!sessionDid) {
      this.sendError(ws, seqId, "Session DID is required", 400);
      return;
    }

    const session = await sessionManager.getSession(documentId, sessionDid);
    if (!session) {
      this.sendError(ws, seqId, "Session not found", 404);
      return;
    }

    const ownerDid = await authService.verifyOwnerToken(ownerToken, contractAddress, ownerAddress);

    if (ownerDid !== session.ownerDid) {
      this.sendError(ws, seqId, "Unauthorized", 401);
      return;
    }

    await this.broadcastToDocument(
      documentId,
      session.sessionDid,
      {
        type: "SESSION_TERMINATED",
        event_type: "SESSION_TERMINATED",
        event: {
          data: null,
          roomId: documentId,
        },
      },
      ws.clientId
    );

    await sessionManager.terminateSession(documentId, session.sessionDid);

    this.sendMessage(ws, {
      status: true,
      statusCode: 200,
      seqId,
      is_handshake_response: false,
      data: { message: "Session terminated" },
    });
  }

  private async setupSession(ws: AuthenticatedWebSocket, args: any) {
    const { documentId, ownerToken, ownerAddress, contractAddress, sessionDid } = args;

    if (!documentId || !ownerToken || !sessionDid) {
      this.sendError(ws, null, "Document ID and token are required", 400);
      return false;
    }

    const ownerDid = await authService.verifyOwnerToken(ownerToken, contractAddress, ownerAddress);

    if (!ownerDid) {
      this.sendError(ws, null, "Authentication failed", 401);
      return false;
    }

    ws.authenticated = true;
    ws.role = "owner";
    ws.sessionDid = sessionDid;

    await sessionManager.createSession({
      documentId,
      sessionDid: sessionDid,
      ownerDid,
      roomInfo: args.roomInfo,
    });

    await sessionManager.addClientToSession(documentId, sessionDid, ws.clientId!);
    console.log("SETUP DONE", documentId);
    return true;
  }

  private async handleJoinSession(ws: AuthenticatedWebSocket, args: any) {
    const {
      documentId,
      collaborationToken,
      ownerToken,
      ownerAddress,
      contractAddress,
      sessionDid,
    } = args;

    if (!documentId || !collaborationToken || !sessionDid) {
      this.sendError(
        ws,
        null,
        "Document ID, collaboration token, and session DID are required",
        400
      );
      return false;
    }

    const session = await sessionManager.getSession(documentId, sessionDid);

    if (!session) {
      this.sendError(ws, null, "Session not found", 404);
      return false;
    }

    const userDid = await authService.verifyCollaborationToken(
      collaborationToken,
      session.sessionDid
    );

    if (!userDid) {
      this.sendError(ws, null, "Authentication failed", 401);
      return false;
    }

    let ownerDid = null;
    if (ownerToken && ownerAddress && contractAddress) {
      ownerDid = await authService.verifyOwnerToken(ownerToken, contractAddress, ownerAddress);
    }

    ws.authenticated = true;
    ws.role = ownerDid === session.ownerDid ? "owner" : "editor";
    ws.documentId = documentId;
    ws.sessionDid = session.sessionDid;

    if (ws.role === "owner" && args.roomInfo) {
      await sessionManager.updateRoomInfo(
        documentId,
        session.sessionDid,
        session.ownerDid,
        args.roomInfo
      );
    }

    await sessionManager.addClientToSession(documentId, session.sessionDid, ws.clientId!);

    console.log("JOINED SESSION", documentId, ws.role);
    return true;
  }

  private async handleAuth(ws: AuthenticatedWebSocket, args: any, seqId: string) {
    const { collaborationToken } = args;

    if (!collaborationToken) {
      this.sendError(ws, seqId, "Username and token are required", 400);
      return;
    }

    const documentId = args.documentId;

    if (!documentId) {
      this.sendError(ws, seqId, "Document ID is required", 400);
      return;
    }

    ws.documentId = documentId;

    let isVerified = false;
    const { sessionDid } = args;

    if (!sessionDid) {
      this.sendError(ws, seqId, "Session DID is required", 400);
      return;
    }

    const existingSession = await sessionManager.getSession(documentId, sessionDid);

    if (!existingSession) {
      isVerified = await this.setupSession(ws, args);
    } else {
      isVerified = await this.handleJoinSession(ws, args);
    }

    if (!isVerified) {
      this.sendError(ws, seqId, "Authentication failed", 401);
      return;
    }

    // Notify other users about membership change
    await this.broadcastToDocument(
      documentId,
      ws.sessionDid!,
      {
        type: "ROOM_UPDATE",
        event_type: "ROOM_MEMBERSHIP_CHANGE",
        event: {
          data: {
            action: "user_joined",
            user: {
              role: ws.role,
            },
          },
          roomId: documentId,
        },
      },
      ws.clientId
    );

    this.sendMessage(ws, {
      status: true,
      statusCode: 200,
      seqId,
      is_handshake_response: true,
      data: {
        message: "Authentication successful",
        role: ws.role,
        sessionType: existingSession ? "existing" : "new",
        roomInfo: existingSession?.roomInfo,
      },
    });
  }

  private async handleDocumentUpdate(ws: AuthenticatedWebSocket, args: any, seqId: string) {
    if (!ws.authenticated || !ws.documentId || !ws.sessionDid) {
      this.sendError(ws, seqId, "Not authenticated or session not found", 401);
      return;
    }

    const { data, collaborationToken } = args;
    const documentId = args.documentId || ws.documentId;

    if (!data) {
      this.sendError(ws, seqId, "Update data is required", 400);
      return;
    }

    const session = await sessionManager.getRuntimeSession(documentId, ws.sessionDid);
    const sessionDid = session?.sessionDid;

    if (!sessionDid) {
      this.sendError(ws, seqId, "Session not found", 404);
      return;
    }

    const isVerified = await authService.verifyCollaborationToken(collaborationToken, sessionDid!);

    if (!isVerified) {
      this.sendError(ws, seqId, "Authentication failed", 401);
      return;
    }

    // Create update record
    const update = await mongodbStore.createUpdate({
      id: uuidv4(),
      documentId,

      data,
      updateType: "yjs_update",
      committed: false,
      commitCid: null,
      createdAt: Date.now(),
      sessionDid: sessionDid,
    });

    // Broadcast update to other clients
    await this.broadcastToDocument(
      documentId,
      ws.sessionDid!,
      {
        type: "CONTENT_UPDATE",
        event_type: "CONTENT_UPDATE",
        event: {
          data: {
            id: update.id,
            data: update.data,

            createdAt: update.createdAt,
          },
          roomId: documentId,
        },
      },
      ws.clientId
    );

    this.sendMessage(ws, {
      status: true,
      statusCode: 200,
      seqId,
      is_handshake_response: false,
      data: {
        commitCid: update.commitCid,
        createdAt: update.createdAt,
        data: update.data,
        documentId: update.documentId,
        id: update.id,
        updateType: update.updateType,
      },
    });
  }

  private async handleDocumentCommit(ws: AuthenticatedWebSocket, args: any, seqId: string) {
    if (!ws.authenticated || !ws.documentId || !ws.sessionDid) {
      this.sendError(ws, seqId, "Not authenticated or session not found", 401);
      return;
    }

    if (ws.role !== "owner") {
      this.sendError(ws, seqId, "Only owners can create commits", 403);
      return;
    }

    const { updates, cid, ownerToken } = args;
    const documentId = args.documentId || ws.documentId;

    const session = await sessionManager.getRuntimeSession(documentId, ws.sessionDid);
    const sessionDid = session?.sessionDid;

    if (!sessionDid) {
      this.sendError(ws, seqId, "Session not found", 404);
      return;
    }

    if (!updates || !Array.isArray(updates) || !cid) {
      this.sendError(ws, seqId, "Updates array and CID are required", 400);
      return;
    }

    const isVerified = await authService.verifyOwnerToken(
      ownerToken,
      args.contractAddress,
      args.ownerAddress
    );

    if (!isVerified) {
      this.sendError(ws, seqId, "Authentication failed", 401);
      return;
    }

    // Create commit record
    const commit = await mongodbStore.createCommit({
      id: uuidv4(),
      documentId,

      cid,
      updates,
      createdAt: Date.now(),
      sessionDid: sessionDid,
    });

    this.sendMessage(ws, {
      status: true,
      statusCode: 200,
      seqId,
      is_handshake_response: false,
      data: {
        cid: commit.cid,
        createdAt: commit.createdAt,
        documentId: commit.documentId,
        updates: commit.updates,
      },
    });
  }

  private async handleCommitHistory(ws: AuthenticatedWebSocket, args: any, seqId: string) {
    if (!ws.authenticated || !ws.documentId) {
      this.sendError(ws, seqId, "Not authenticated", 401);
      return;
    }

    const documentId = args.documentId || ws.documentId;
    const { offset = 0, limit = 10, sort = "desc" } = args;

    const commits = await mongodbStore.getCommitsByDocument(documentId, {
      offset,
      limit,
      sort,
    });

    this.sendMessage(ws, {
      status: true,
      statusCode: 200,
      seqId,
      is_handshake_response: false,
      data: {
        history: commits,
        total: commits.length,
      },
    });
  }

  private async handleUpdateHistory(ws: AuthenticatedWebSocket, args: any, seqId: string) {
    if (!ws.authenticated || !ws.documentId) {
      this.sendError(ws, seqId, "Not authenticated", 401);
      return;
    }

    const documentId = args.documentId || ws.documentId;
    const { offset = 0, limit = 100, sort = "desc", filters = {} } = args;

    const updates = await mongodbStore.getUpdatesByDocument(documentId, {
      offset,
      limit,
      sort,
      committed: filters.committed,
    });

    this.sendMessage(ws, {
      status: true,
      statusCode: 200,
      seqId,
      is_handshake_response: false,
      data: {
        history: updates,
        total: updates.length,
      },
    });
  }

  private async handlePeersList(ws: AuthenticatedWebSocket, args: any, seqId: string) {
    if (!ws.authenticated || !ws.documentId || !ws.sessionDid) {
      this.sendError(ws, seqId, "Not authenticated or session not found", 401);
      return;
    }

    const documentId = args.documentId || ws.documentId;

    const session = await sessionManager.getSession(documentId, ws.sessionDid);
    const peers = session?.clients;

    this.sendMessage(ws, {
      status: true,
      statusCode: 200,
      seqId,
      is_handshake_response: false,
      data: {
        peers: Array.from(peers || []),
      },
    });
  }

  private async handleAwareness(ws: AuthenticatedWebSocket, args: any, seqId: string) {
    if (!ws.authenticated || !ws.documentId || !ws.sessionDid) {
      this.sendError(ws, seqId, "Not authenticated or session not found", 401);
      return;
    }

    const documentId = args.documentId || ws.documentId;
    const { data } = args;

    // Broadcast awareness update to other clients
    await this.broadcastToDocument(
      documentId,
      ws.sessionDid!,
      {
        type: "AWARENESS_UPDATE",
        event_type: "AWARENESS_UPDATE",
        event: {
          data,
          roomId: documentId,
        },
      },
      ws.clientId
    );

    this.sendMessage(ws, {
      status: true,
      statusCode: 200,
      seqId,
      is_handshake_response: false,
      data: {
        message: "Awareness update broadcasted",
      },
    });
  }

  private async handleDisconnection(clientId: string) {
    const ws = this.connections.get(clientId);
    if (ws && ws.authenticated && ws.documentId) {
      // Notify other users about membership change BEFORE removing from connections
      if (ws.sessionDid) {
        await this.broadcastToDocument(
          ws.documentId,
          ws.sessionDid,
          {
            type: "ROOM_UPDATE",
            event_type: "ROOM_MEMBERSHIP_CHANGE",
            event: {
              data: {
                action: "user_left",
                user: {
                  role: ws.role,
                },
              },
              roomId: ws.documentId,
            },
          },
          clientId
        );
      }

      // Remove from session and handle session cleanup
      if (ws.sessionDid) {
        await sessionManager.removeClientFromSession(ws.documentId, ws.sessionDid, clientId);
      }
    }

    this.connections.delete(clientId);
    console.log(`WebSocket disconnected: ${clientId}`);
  }

  private sendMessage(ws: AuthenticatedWebSocket, response: WebSocketResponse) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(response));
    }
  }

  private sendError(
    ws: AuthenticatedWebSocket,
    seqId: string | null,
    error: string,
    statusCode: number
  ) {
    this.sendMessage(ws, {
      status: false,
      statusCode,
      seqId,
      is_handshake_response: false,
      err: error,
    });
  }

  private async broadcastToDocument(
    documentId: string,
    sessionDid: string,
    event: WebSocketEvent,
    excludeClientId?: string
  ) {
    // Use the new cross-dyno broadcasting system
    await sessionManager.broadcastToAllDynos(documentId, sessionDid, event, excludeClientId);
  }

  async getStats() {
    return {
      totalConnections: this.connections.size,
      authenticatedConnections: Array.from(this.connections.values()).filter(
        (ws) => ws.authenticated
      ).length,
      runtimeSessions: await sessionManager.getActiveSessionsCount(),
      ...(await mongodbStore.getStats()),
    };
  }
}

export const wsManager = new WebSocketManager();
