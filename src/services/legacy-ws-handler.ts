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
import type { BroadcastBridge } from "./broadcast-bridge";

/**
 * Handles legacy raw WebSocket connections from old clients (pre-Socket.IO).
 * Ported from prod's WebSocketManager, adapted to use the BroadcastBridge
 * for cross-protocol communication instead of Redis pub/sub.
 */
export class LegacyWebSocketHandler {
  private connections = new Map<string, AuthenticatedWebSocket>();
  private bridge: BroadcastBridge | null = null;

  setBridge(bridge: BroadcastBridge): void {
    this.bridge = bridge;
  }

  handleConnection(ws: WebSocket): void {
    const clientId = uuidv4();
    const authWs = ws as AuthenticatedWebSocket;
    authWs.clientId = clientId;
    authWs.authenticated = false;

    this.connections.set(clientId, authWs);
    console.log(`[Legacy WS] New connection: ${clientId}`);

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
        console.error(`[Legacy WS] Error handling message from ${clientId}:`, error);
        this.sendError(authWs, null, "Invalid message format", 400);
      }
    });

    authWs.on("close", () => {
      this.handleDisconnection(clientId).catch((error) => {
        console.error(`[Legacy WS] Error during disconnection cleanup for ${clientId}:`, error);
      });
    });

    authWs.on("error", (error) => {
      console.error(`[Legacy WS] WebSocket error for ${clientId}:`, error);
      this.handleDisconnection(clientId).catch((err) => {
        console.error(`[Legacy WS] Error during disconnection cleanup for ${clientId}:`, err);
      });
    });
  }

  /**
   * Called by bridge to dispatch events to legacy clients in a room.
   */
  broadcastToLegacyClients(
    documentId: string,
    sessionDid: string,
    event: WebSocketEvent,
    excludeClientId?: string
  ): void {
    const clients = sessionManager.getLocalClients(documentId, sessionDid);
    if (!clients) return;

    const message = JSON.stringify(event);

    clients.forEach((clientId: string) => {
      if (clientId === excludeClientId) return;

      const ws = this.connections.get(clientId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    });
  }

  /**
   * Returns list of legacy client IDs in a room.
   */
  getLegacyPeers(documentId: string, sessionDid: string): string[] {
    const clients = sessionManager.getLocalClients(documentId, sessionDid);
    if (!clients) return [];

    const peers: string[] = [];
    clients.forEach((clientId: string) => {
      if (this.connections.has(clientId)) {
        peers.push(clientId);
      }
    });
    return peers;
  }

  /**
   * Force-disconnects all legacy clients in a room.
   */
  disconnectClientsInRoom(
    documentId: string,
    sessionDid: string,
    excludeClientId?: string
  ): void {
    const clients = sessionManager.getLocalClients(documentId, sessionDid);
    if (!clients) return;

    // Only close connections — callers are responsible for broadcasting
    // SESSION_TERMINATED before calling this method.
    clients.forEach((clientId: string) => {
      if (clientId === excludeClientId) return;

      const ws = this.connections.get(clientId);
      if (ws) {
        ws.close();
      }
    });
  }

  /**
   * Closes all legacy WebSocket connections.
   */
  closeAll(): void {
    for (const [, ws] of this.connections) {
      ws.close();
    }
    this.connections.clear();
  }

  // ─── Internal message handling ───────────────────────────

  private async handleMessage(ws: AuthenticatedWebSocket, message: WebSocketMessage): Promise<void> {
    const { cmd, args, seqId } = message;

    try {
      switch (cmd) {
        case "/auth":
          await this.handleAuth(ws, args, seqId);
          break;
        case "/documents/update":
          await this.handleDocumentUpdate(ws, args, seqId);
          break;
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
      console.error(`[Legacy WS] Error handling command ${cmd}:`, error);
      this.sendError(ws, seqId, "Internal server error", 500);
    }
  }

  private async handleAuth(ws: AuthenticatedWebSocket, args: any, seqId: string): Promise<void> {
    const { collaborationToken, documentId, sessionDid } = args;

    if (!collaborationToken) {
      this.sendError(ws, seqId, "Username and token are required", 400);
      return;
    }

    if (!documentId) {
      this.sendError(ws, seqId, "Document ID is required", 400);
      return;
    }

    if (!sessionDid) {
      this.sendError(ws, seqId, "Session DID is required", 400);
      return;
    }

    ws.documentId = documentId;

    let sessionSetupResponse = {
      isVerified: false,
      message: "",
      statusCode: 0,
    };

    const existingSession = await sessionManager.getSession(documentId, sessionDid);

    if (!existingSession && args.ownerToken) {
      sessionSetupResponse = await this.setupSession(ws, args);
    } else {
      sessionSetupResponse = await this.handleJoinSession(ws, args, existingSession);
    }

    if (!sessionSetupResponse.isVerified) {
      this.sendError(ws, seqId, sessionSetupResponse.message, sessionSetupResponse.statusCode);
      return;
    }

    // Notify other users about membership change via bridge
    if (this.bridge) {
      this.bridge.broadcastFromLegacy(
        documentId,
        ws.sessionDid!,
        {
          type: "ROOM_UPDATE",
          event_type: "ROOM_MEMBERSHIP_CHANGE",
          event: {
            data: {
              action: "user_joined",
              user: { role: ws.role },
            },
            roomId: documentId,
          },
        },
        ws.clientId
      );
    }

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

  private async setupSession(ws: AuthenticatedWebSocket, args: any) {
    const { documentId, ownerToken, ownerAddress, contractAddress, sessionDid } = args;

    if (!documentId || !ownerToken || !sessionDid) {
      return {
        isVerified: false,
        message: "Document ID, owner token, and session DID are required",
        statusCode: 400,
      };
    }

    const ownerDid = await authService.verifyOwnerToken(ownerToken, contractAddress, ownerAddress);

    if (!ownerDid) {
      return {
        isVerified: false,
        message: "Authentication failed",
        statusCode: 401,
      };
    }

    ws.authenticated = true;
    ws.role = "owner";
    ws.sessionDid = sessionDid;

    // Terminate other sessions (with bridge notification)
    const otherSessions = await sessionManager.getOtherActiveSessions(
      documentId,
      ownerDid,
      sessionDid
    );
    for (const oldSession of otherSessions) {
      if (this.bridge) {
        // Notify Socket.IO clients with error reason before termination
        this.bridge.emitServerError(
          oldSession.documentId,
          oldSession.sessionDid,
          "Session terminated by owner creating a new session"
        );
        // Notify both protocols about termination
        this.bridge.broadcastFromLegacy(
          oldSession.documentId,
          oldSession.sessionDid,
          {
            type: "SESSION_TERMINATED",
            event_type: "SESSION_TERMINATED",
            event: { data: null, roomId: oldSession.documentId },
          }
        );
        await this.bridge.terminateRoom(oldSession.documentId, oldSession.sessionDid);
      }
      await sessionManager.terminateSession(oldSession.documentId, oldSession.sessionDid);
      console.log(
        `[Legacy WS] Terminated old session: ${oldSession.sessionDid} for document: ${documentId}`
      );
    }

    await sessionManager.createSession({
      documentId,
      sessionDid,
      ownerDid,
      roomInfo: args.roomInfo,
    });

    await sessionManager.addClientToSession(documentId, sessionDid, ws.clientId!);
    console.log("[Legacy WS] SETUP DONE", documentId);
    return {
      isVerified: true,
      message: "Session setup successful",
      statusCode: 200,
    };
  }

  private async handleJoinSession(ws: AuthenticatedWebSocket, args: any, session: any) {
    if (!session) {
      return {
        isVerified: false,
        message: "Session not found",
        statusCode: 404,
      };
    }

    const {
      documentId,
      collaborationToken,
      ownerToken,
      ownerAddress,
      contractAddress,
      sessionDid,
    } = args;

    if (!documentId || !collaborationToken || !sessionDid) {
      return {
        isVerified: false,
        message: "Document ID, collaboration token, and session DID are required",
        statusCode: 400,
      };
    }

    const userDid = await authService.verifyCollaborationToken(
      collaborationToken,
      session.sessionDid,
      documentId
    );

    if (!userDid) {
      return {
        isVerified: false,
        message: "Authentication failed",
        statusCode: 401,
      };
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

    console.log("[Legacy WS] JOINED SESSION", documentId, ws.role);
    return {
      isVerified: true,
      message: "Session joined successfully",
      statusCode: 200,
    };
  }

  private async handleDocumentUpdate(ws: AuthenticatedWebSocket, args: any, seqId: string): Promise<void> {
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

    const isVerified = await authService.verifyCollaborationToken(
      collaborationToken,
      sessionDid,
      documentId
    );

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
      sessionDid,
    });

    // Broadcast update to other clients via bridge (both protocols)
    if (this.bridge) {
      this.bridge.broadcastFromLegacy(
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
    }

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

  private async handleDocumentCommit(ws: AuthenticatedWebSocket, args: any, seqId: string): Promise<void> {
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
      sessionDid,
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

  private async handleCommitHistory(ws: AuthenticatedWebSocket, args: any, seqId: string): Promise<void> {
    if (!ws.authenticated || !ws.documentId || !ws.sessionDid) {
      this.sendError(ws, seqId, "Not authenticated", 401);
      return;
    }

    const documentId = args.documentId || ws.documentId;
    const { offset = 0, limit = 10, sort = "desc" } = args;

    const commits = await mongodbStore.getCommitsByDocument(
      { documentId, sessionDid: ws.sessionDid },
      { offset, limit, sort }
    );

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

  private async handleUpdateHistory(ws: AuthenticatedWebSocket, args: any, seqId: string): Promise<void> {
    if (!ws.authenticated || !ws.documentId || !ws.sessionDid) {
      this.sendError(ws, seqId, "Not authenticated", 401);
      return;
    }

    const documentId = args.documentId || ws.documentId;
    const { offset = 0, limit = 100, sort = "desc", filters = {} } = args;

    const updates = await mongodbStore.getUpdatesByDocument(
      { documentId, sessionDid: ws.sessionDid },
      { offset, limit, sort, committed: filters.committed }
    );

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

  private async handlePeersList(ws: AuthenticatedWebSocket, args: any, seqId: string): Promise<void> {
    if (!ws.authenticated || !ws.documentId || !ws.sessionDid) {
      this.sendError(ws, seqId, "Not authenticated or session not found", 401);
      return;
    }

    const documentId = args.documentId || ws.documentId;

    // Use bridge to get combined peers from both protocols
    let peers: string[] = [];
    if (this.bridge) {
      peers = await this.bridge.getCombinedPeers(documentId, ws.sessionDid);
    } else {
      const session = await sessionManager.getSession(documentId, ws.sessionDid);
      peers = Array.from(session?.clients || []);
    }

    this.sendMessage(ws, {
      status: true,
      statusCode: 200,
      seqId,
      is_handshake_response: false,
      data: { peers },
    });
  }

  private async handleAwareness(ws: AuthenticatedWebSocket, args: any, seqId: string): Promise<void> {
    if (!ws.authenticated || !ws.documentId || !ws.sessionDid) {
      this.sendError(ws, seqId, "Not authenticated or session not found", 401);
      return;
    }

    const documentId = args.documentId || ws.documentId;
    const { data } = args;

    // Broadcast awareness update via bridge (both protocols)
    if (this.bridge) {
      this.bridge.broadcastFromLegacy(
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
    }

    this.sendMessage(ws, {
      status: true,
      statusCode: 200,
      seqId,
      is_handshake_response: false,
      data: { message: "Awareness update broadcasted" },
    });
  }

  private async handleTerminateSession(ws: AuthenticatedWebSocket, args: any, seqId: string): Promise<void> {
    const { documentId, ownerToken, ownerAddress, contractAddress, sessionDid } = args;
    console.log("[Legacy WS] TERMINATING SESSION", documentId);

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

    // Broadcast termination to both protocols via bridge
    if (this.bridge) {
      this.bridge.broadcastFromLegacy(
        documentId,
        session.sessionDid,
        {
          type: "SESSION_TERMINATED",
          event_type: "SESSION_TERMINATED",
          event: { data: null, roomId: documentId },
        },
        ws.clientId
      );
      // Also disconnect all clients in both protocols
      await this.bridge.terminateRoom(documentId, session.sessionDid, ws.clientId);
    }

    await sessionManager.terminateSession(documentId, session.sessionDid);

    this.sendMessage(ws, {
      status: true,
      statusCode: 200,
      seqId,
      is_handshake_response: false,
      data: { message: "Session terminated" },
    });
  }

  private async handleDisconnection(clientId: string): Promise<void> {
    const ws = this.connections.get(clientId);
    if (ws && ws.authenticated && ws.documentId && ws.sessionDid) {
      // Notify other users about membership change via bridge
      if (this.bridge) {
        this.bridge.broadcastFromLegacy(
          ws.documentId,
          ws.sessionDid,
          {
            type: "ROOM_UPDATE",
            event_type: "ROOM_MEMBERSHIP_CHANGE",
            event: {
              data: {
                action: "user_left",
                user: { role: ws.role },
              },
              roomId: ws.documentId,
            },
          },
          clientId
        );
      }

      // Remove from session and handle session cleanup
      await sessionManager.removeClientFromSession(ws.documentId, ws.sessionDid, clientId);
    }

    this.connections.delete(clientId);
    console.log(`[Legacy WS] Disconnected: ${clientId}`);
  }

  private sendMessage(ws: AuthenticatedWebSocket, response: WebSocketResponse): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(response));
    }
  }

  private sendError(
    ws: AuthenticatedWebSocket,
    seqId: string | null,
    error: string,
    statusCode: number
  ): void {
    this.sendMessage(ws, {
      status: false,
      statusCode,
      seqId,
      is_handshake_response: false,
      err: error,
    });
  }
}
