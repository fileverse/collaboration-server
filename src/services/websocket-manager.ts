import { WebSocket } from "ws";
import { v4 as uuidv4 } from "uuid";
import {
  AuthenticatedWebSocket,
  WebSocketMessage,
  WebSocketResponse,
  WebSocketEvent,
} from "../types/index";
import { authService } from "./auth";
import { memoryStore } from "./memory-store";

export class WebSocketManager {
  private connections = new Map<string, AuthenticatedWebSocket>();
  private documentConnections = new Map<string, Set<string>>();

  constructor() {
    this.handleConnection = this.handleConnection.bind(this);
  }

  handleConnection(ws: WebSocket) {
    const clientId = uuidv4();
    const authWs = ws as AuthenticatedWebSocket;
    authWs.client_id = clientId;
    authWs.authenticated = false;

    this.connections.set(clientId, authWs);

    console.log(`New WebSocket connection: ${clientId}`);

    // Send handshake with server DID
    this.sendMessage(authWs, {
      status: true,
      status_code: 200,
      seq_id: null,
      is_handshake_response: true,
      data: {
        server_did: "did:key:z6MkvLz3MR8Za2MMq7ezmN7QBH1otrV4p3ecnLCjHto6g4VS",
        // authService.getServerDid(),
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
      this.handleDisconnection(clientId);
    });

    authWs.on("error", (error) => {
      console.error(`WebSocket error for ${clientId}:`, error);
      this.handleDisconnection(clientId);
    });
  }

  private async handleMessage(ws: AuthenticatedWebSocket, message: WebSocketMessage) {
    const { cmd, args, seq_id } = message;

    try {
      switch (cmd) {
        case "/auth":
          await this.handleAuth(ws, args, seq_id);
          break;
        case "/documents/update": {
          console.log("args", args);
          await this.handleDocumentUpdate(ws, args, seq_id);
          break;
        }
        case "/documents/commit":
          await this.handleDocumentCommit(ws, args, seq_id);
          break;
        case "/documents/commit/history":
          await this.handleCommitHistory(ws, args, seq_id);
          break;
        case "/documents/update/history":
          await this.handleUpdateHistory(ws, args, seq_id);
          break;
        case "/documents/peers/list":
          await this.handlePeersList(ws, args, seq_id);
          break;
        case "/documents/awareness":
          await this.handleAwareness(ws, args, seq_id);
          break;
        default:
          this.sendError(ws, seq_id, `Unknown command: ${cmd}`, 404);
      }
    } catch (error) {
      console.error(`Error handling command ${cmd}:`, error);
      this.sendError(ws, seq_id, "Internal server error", 500);
    }
  }

  private async handleAuth(ws: AuthenticatedWebSocket, args: any, seq_id: string) {
    const { username, token } = args;

    if (!username || !token) {
      this.sendError(ws, seq_id, "Username and token are required", 400);
      return;
    }

    console.log(args.document_id, "document_id");

    // For now, we'll extract document_id from args or use a default
    const documentId = args.document_id || "default-room";

    // const authResult = await authService.verifyUCAN(token, documentId);

    // if (!authResult.isValid) {
    //   this.sendError(ws, seq_id, authResult.error || "Authentication failed", 401);
    //   return;
    // }

    // Set user information
    ws.user_id = username;
    // authService.extractUserIdFromDid(authResult.userDid!);
    ws.username = username;
    ws.document_id = documentId;
    ws.role = "owner";
    // await authService.getUserRole(documentId, authResult.userDid!);
    ws.authenticated = true;

    // Add to document connections
    if (!this.documentConnections.has(documentId)) {
      this.documentConnections.set(documentId, new Set());
    }
    this.documentConnections.get(documentId)!.add(ws.client_id!);
    console.log("this.documentConnections", this.documentConnections);
    // Add to room members
    memoryStore.addRoomMember(documentId, {
      user_id: ws.user_id!,
      username: ws.username!,
      role: ws.role,
      client_id: ws.client_id,
      joined_at: Date.now(),
    });

    // Notify other users about membership change
    this.broadcastToDocument(
      documentId,
      {
        type: "ROOM_UPDATE",
        event_type: "ROOM_MEMBERSHIP_CHANGE",
        event: {
          data: {
            action: "user_joined",
            user: {
              user_id: ws.user_id,
              username: ws.username,
              role: ws.role,
            },
          },
          roomId: documentId,
        },
      },
      ws.client_id
    );

    this.sendMessage(ws, {
      status: true,
      status_code: 200,
      seq_id,
      is_handshake_response: true,
      data: {
        message: "Authentication successful",
        user_id: ws.user_id,
        role: ws.role,
      },
    });
  }

  private async handleDocumentUpdate(ws: AuthenticatedWebSocket, args: any, seq_id: string) {
    if (!ws.authenticated || !ws.document_id) {
      this.sendError(ws, seq_id, "Not authenticated", 401);
      return;
    }

    const { data, update_snapshot_ref } = args;
    const document_id = args.document_id || ws.document_id;
    console.log("data", data);
    if (!data) {
      this.sendError(ws, seq_id, "Update data is required", 400);
      return;
    }

    // Create update record
    const update = memoryStore.createUpdate({
      id: uuidv4(),
      document_id,
      agent_id: ws.user_id!,
      data,
      update_type: "yjs_update",
      committed: false,
      commit_cid: null,
      update_snapshot_ref,
      created_at: Date.now(),
    });

    // Broadcast update to other clients
    this.broadcastToDocument(
      document_id,
      {
        type: "CONTENT_UPDATE",
        event_type: "CONTENT_UPDATE",
        event: {
          data: {
            id: update.id,
            data: update.data,
            agent_id: update.agent_id,
            created_at: update.created_at,
          },
          roomId: document_id,
        },
      },
      ws.client_id
    );

    this.sendMessage(ws, {
      status: true,
      status_code: 200,
      seq_id,
      is_handshake_response: false,
      data: {
        agent_id: update.agent_id,
        commit_cid: update.commit_cid,
        created_at: update.created_at,
        data: update.data,
        document_id: update.document_id,
        id: update.id,
        update_snapshot_ref: update.update_snapshot_ref,
        update_type: update.update_type,
      },
    });
  }

  private async handleDocumentCommit(ws: AuthenticatedWebSocket, args: any, seq_id: string) {
    if (!ws.authenticated || !ws.document_id) {
      this.sendError(ws, seq_id, "Not authenticated", 401);
      return;
    }

    if (ws.role !== "owner") {
      this.sendError(ws, seq_id, "Only owners can create commits", 403);
      return;
    }

    const { updates, cid, data } = args;
    const document_id = args.document_id || ws.document_id;

    if (!updates || !Array.isArray(updates) || !cid) {
      this.sendError(ws, seq_id, "Updates array and CID are required", 400);
      return;
    }

    // Create commit record
    const commit = memoryStore.createCommit({
      id: uuidv4(),
      document_id,
      agent_id: ws.user_id!,
      cid,
      data,
      updates,
      created_at: Date.now(),
    });

    this.sendMessage(ws, {
      status: true,
      status_code: 200,
      seq_id,
      is_handshake_response: false,
      data: {
        agent_id: commit.agent_id,
        cid: commit.cid,
        created_at: commit.created_at,
        data: commit.data,
        document_id: commit.document_id,
        updates: commit.updates,
      },
    });
  }

  private async handleCommitHistory(ws: AuthenticatedWebSocket, args: any, seq_id: string) {
    if (!ws.authenticated || !ws.document_id) {
      this.sendError(ws, seq_id, "Not authenticated", 401);
      return;
    }

    const document_id = args.document_id || ws.document_id;
    const { offset = 0, limit = 10, sort = "desc" } = args;

    const commits = memoryStore.getCommitsByDocument(document_id, {
      offset,
      limit,
      sort,
    });

    this.sendMessage(ws, {
      status: true,
      status_code: 200,
      seq_id,
      is_handshake_response: false,
      data: {
        history: commits,
        total: commits.length,
      },
    });
  }

  private async handleUpdateHistory(ws: AuthenticatedWebSocket, args: any, seq_id: string) {
    if (!ws.authenticated || !ws.document_id) {
      this.sendError(ws, seq_id, "Not authenticated", 401);
      return;
    }

    const document_id = args.document_id || ws.document_id;
    const { offset = 0, limit = 100, sort = "desc", filters = {} } = args;

    const updates = memoryStore.getUpdatesByDocument(document_id, {
      offset,
      limit,
      sort,
      committed: filters.committed,
    });

    this.sendMessage(ws, {
      status: true,
      status_code: 200,
      seq_id,
      is_handshake_response: false,
      data: {
        history: updates,
        total: updates.length,
      },
    });
  }

  private async handlePeersList(ws: AuthenticatedWebSocket, args: any, seq_id: string) {
    if (!ws.authenticated || !ws.document_id) {
      this.sendError(ws, seq_id, "Not authenticated", 401);
      return;
    }

    const document_id = args.document_id || ws.document_id;
    const peers = memoryStore.getRoomMembers(document_id);

    this.sendMessage(ws, {
      status: true,
      status_code: 200,
      seq_id,
      is_handshake_response: false,
      data: {
        peers,
      },
    });
  }

  private async handleAwareness(ws: AuthenticatedWebSocket, args: any, seq_id: string) {
    if (!ws.authenticated || !ws.document_id) {
      this.sendError(ws, seq_id, "Not authenticated", 401);
      return;
    }

    const document_id = args.document_id || ws.document_id;
    const { data } = args;

    // Broadcast awareness update to other clients
    this.broadcastToDocument(
      document_id,
      {
        type: "AWARENESS_UPDATE",
        event_type: "AWARENESS_UPDATE",
        event: {
          data,
          roomId: document_id,
        },
      },
      ws.client_id
    );

    this.sendMessage(ws, {
      status: true,
      status_code: 200,
      seq_id,
      is_handshake_response: false,
      data: {
        message: "Awareness update broadcasted",
      },
    });
  }

  private handleDisconnection(clientId: string) {
    const ws = this.connections.get(clientId);
    if (ws && ws.authenticated && ws.document_id) {
      // Notify other users about membership change BEFORE removing from connections
      this.broadcastToDocument(
        ws.document_id,
        {
          type: "ROOM_UPDATE",
          event_type: "ROOM_MEMBERSHIP_CHANGE",
          event: {
            data: {
              action: "user_left",
              user: {
                user_id: ws.user_id,
                username: ws.username,
                role: ws.role,
              },
            },
            roomId: ws.document_id,
          },
        },
        clientId
      );

      // Remove from document connections
      const docConnections = this.documentConnections.get(ws.document_id);
      if (docConnections) {
        docConnections.delete(clientId);
        if (docConnections.size === 0) {
          this.documentConnections.delete(ws.document_id);
        }
      }

      // Remove from room members
      memoryStore.removeRoomMember(ws.document_id, ws.user_id!);
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
    seq_id: string | null,
    error: string,
    status_code: number
  ) {
    this.sendMessage(ws, {
      status: false,
      status_code,
      seq_id,
      is_handshake_response: false,
      err: error,
    });
  }

  private broadcastToDocument(documentId: string, event: WebSocketEvent, excludeClientId?: string) {
    console.log("documentId", documentId);
    const connections = this.documentConnections.get(documentId);
    console.log("connections", connections);
    if (!connections) return;

    const message = JSON.stringify(event);
    connections.forEach((clientId) => {
      if (clientId === excludeClientId) return;

      const ws = this.connections.get(clientId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    });
  }

  getStats() {
    return {
      totalConnections: this.connections.size,
      authenticatedConnections: Array.from(this.connections.values()).filter(
        (ws) => ws.authenticated
      ).length,
      activeDocuments: this.documentConnections.size,
      ...memoryStore.getStats(),
    };
  }
}

export const wsManager = new WebSocketManager();
