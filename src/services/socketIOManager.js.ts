import { uuidv4 } from "lib0/random";
import { Socket as SIOSocket } from "socket.io";
import {
  AuthenticatedSIOSocket,
  SIOSocketEvent,
  SIOSocketMessage,
  SIOSocketResponse,
} from "../types/index";
import { authService } from "./auth";
import { sessionManager } from "./session-manager";
import { mongodbStore } from "./mongodb-store";

export class SocketIOManager {
  private connections = new Map<string, AuthenticatedSIOSocket>();

  constructor() {
    this.handleConnection = this.handleConnection.bind(this);
    this.handleCrossDynoBroadcast = this.handleCrossDynoBroadcast.bind(this);
    this.setupSessionBroadcastHandler();
  }

  private setupSessionBroadcastHandler(): void {
    // Setup the broadcast handler for cross-dyno communication.
    sessionManager.setBroadcastHandler(
      async (sessionKey: string, message: any, excludeClientId?: string) => {
        await this.handleCrossDynoBroadcast(sessionKey, message, excludeClientId);
      }
    );
  }

  private async handleCrossDynoBroadcast(
    sessionKey: string,
    message: any,
    excludeClientId?: string,
  ) {
    const localSession = sessionManager['inMemorySessions'].get(sessionKey);
    if (!localSession) {
      return;
    }

    const messageStr = JSON.stringify(message);

    localSession.clients.forEach((clientId: string) => {
      if (clientId === excludeClientId) return;

      const clientSockConn = this.connections.get(clientId);
      if (clientSockConn && clientSockConn.connected) {
        clientSockConn.send(messageStr);
      }
    });
  }

  // TODO: what happens if this function is made private?
  handleConnection(
    socket: SIOSocket,
  ) {
    const clientId = uuidv4();
    const authenticatedSocket = socket as AuthenticatedSIOSocket;
    authenticatedSocket.clientId = clientId;
    authenticatedSocket.authenticated = false;

    this.connections.set(clientId, authenticatedSocket);
    console.log(`New SocketIO connection: ${clientId}`);

    this.sendMessage(authenticatedSocket, {
      status: true,
      statusCode: 200, 
      seqId: null,
      is_handshake_response: true,
      data: {
        server_did: authService.getServerDid(),
        message: 'Connected to collaboration server',
      },
    });

    // TODO: figure out, why Buffer is used as type
    authenticatedSocket.on("message", async (data: Buffer) => {
      try {
        const message: SIOSocketMessage = JSON.parse(data.toString());
        await this.handleMessage(authenticatedSocket, message);
      } catch (error) {
        console.error(`Error handling message from ${clientId}:`, error);
        this.sendError(authenticatedSocket, null, "Invalid message format", 400);
      }
    });
  }

  private async handleMessage(
    socket: AuthenticatedSIOSocket,
    message: SIOSocketMessage,
  ) {
    const { cmd, args, seqId } = message;

    try {
      switch(cmd) { 
        case "/auth": {
          await this.handleAuth(socket, args, seqId);
          break;
        }
        case "/documents/update": {
          await this.handleDocumentUpdate(socket, args, seqId);
          break;
        }
        case "/documents/commit": {
          await this.handleDocumentCommit(socket, args, seqId);
          break;
        }
        case "/documents/commit/history": {
          await this.handleCommitHistory(socket, args, seqId);
          break;
        }
        case "/documents/update/history": {
          await this.handleUpdateHistory(socket, args, seqId);
          break;
        }
        case "/documents/peers/list": {
          await this.handlePeersList(socket, args, seqId);
          break;
        }
        case "/documents/awareness": {
          await this.handleAwareness(socket, args, seqId);
          break;
        }
        case "/documents/terminate": {
          await this.handleTerminateSession(socket, args, seqId);
          break;
        }
        default: {
          this.sendError(socket, seqId, `Unknown command: ${cmd}`, 404);        
        }
      }
    } catch (error) {
      console.error(`Error handling command ${cmd}:`, error);
      this.sendError(socket, seqId, "Internal server error", 500);
    }
  }

  private async handleAuth(
    socket: AuthenticatedSIOSocket,
    args: any,
    seqId: string,
  ) {

  }

  private async handleDocumentUpdate(
    socket: AuthenticatedSIOSocket,
    args: any,
    seqId: string,
  ) {
    if (!socket.authenticated || !socket.documentId || !socket.sessionDid) {
      this.sendError(socket, seqId, 'Not authenticated or session not found', 401);
      return;
    }

    const { data, collaborationToken } = args;
    const documentId = args.documentId || socket.documentId;
    if (!data) {
      this.sendError(socket, seqId, 'Update data is required', 400);
      return;
    }

    const session = await sessionManager.getRuntimeSession(documentId, socket.sessionDid);
    const sessionDid = session?.sessionDid;
    if (!sessionDid) {
      this.sendError(socket, seqId, 'Session not found', 404);
      return;
    }

    const isVerified = await authService.verifyCollaborationToken(
      collaborationToken,
      sessionDid!, // TODO: check. there was an ! after sessionDid
      documentId,
    );
    if (!isVerified) {
      this.sendError(socket, seqId, 'Authentication failed', 401);
      return;
    }

    // Create update record
    const update = await mongodbStore.createUpdate({
      id: uuidv4(),
      documentId,
      data, // this is encrypted yjs btw
      updateType: "yjs_update",
      committed: false,
      commitCid: null,
      createdAt: Date.now(),
      sessionDid: sessionDid,
    });

    // Broadcast the update to other clients (local dyno only) 
    // TODO: I don't know what this "local dyno" stuff means
    await this.broadcastToDocument(
      documentId,
      socket.sessionDid,
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
      socket.clientId, // exclude this client
    );

    this.sendMessage(socket, {
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

  private async handleDocumentCommit(
    socket: AuthenticatedSIOSocket,
    args: any,
    seqId: string,
  ) {
    if (!socket.authenticated || !socket.documentId || !socket.sessionDid) {
      this.sendError(socket, seqId, 'Not authenticated or session not found', 401);
      return;
    }

    if (socket.role !== "owner") {
      this.sendError(socket, seqId, 'Only owners can create commits', 403);
      return;
    }

    const { updates, cid, ownerToken } = args;
    const documentId = args.documentId || socket.documentId;

    const session = await sessionManager.getRuntimeSession(documentId, socket.sessionDid);
    const sessionDid = session?.sessionDid;
    if (!sessionDid) {
      this.sendError(socket, seqId, 'Session not found', 404);
      return;
    }

    if (!updates || !Array.isArray(updates) || !cid) {
      this.sendError(socket, seqId, 'updates array and cid are required', 404);
      return;
    }

    const isVerified = await authService.verifyOwnerToken(
      ownerToken,
      args.contractAddress,
      args.ownerAddress,
    );
    if (!isVerified) {
      this.sendError(socket, seqId, 'Authentication failed', 403);
      return;
    }

    const commit = await mongodbStore.createCommit({
      id: uuidv4(),
      documentId,
      cid,
      updates,
      createdAt: Date.now(),
      sessionDid: sessionDid,
    });

    this.sendMessage(socket, {
      status: true,
      statusCode: 200,
      seqId,
      is_handshake_response: false,
      data: {
        cid: commit.cid,
        createdAt: commit.createdAt,
        documentId: commit.documentId,
        updates: commit.updates,
      }
    });
  }

  private async handleCommitHistory(
    socket: AuthenticatedSIOSocket,
    args: any,
    seqId: string,
  ) {
    if (!socket.authenticated || !socket.documentId || !socket.sessionDid) {
      this.sendError(socket, seqId, 'Not authenticated', 401);
      return;
    }

    const documentId = args.documentId || socket.documentId;
    const { offset = 0, limit = 10, sort = 'desc' } = args;

    const commits = await mongodbStore.getCommitsByDocument(
      {
        documentId,
        sessionDid: socket.sessionDid,
      },
      { offset, limit, sort }
    );

    this.sendMessage(socket, {
      status: true,
      statusCode: 200,
      seqId,
      is_handshake_response: false,
      data: {
        history: commits,
        total: commits.length,
      }
    });
  }

  private async handleUpdateHistory(
    socket: AuthenticatedSIOSocket,
    args: any,
    seqId: string,
  ) {
    if (!socket.authenticated || !socket.documentId || !socket.sessionDid) {
      this.sendError(socket, seqId, 'Not authenticated', 401);
      return;
    }

    const documentId = args.documentId || socket.documentId;
    const { offset = 0, limit = 100, sort = 'desc', filters = {} } = args;

    const query = {
      documentId,
      sessionDid: socket.sessionDid,
    };

    const updates = await mongodbStore.getUpdatesByDocument(query, {
      offset,
      limit,
      sort,
      committed: filters.committed,
    });

    this.sendMessage(socket, {
      status: true,
      statusCode: 200,
      seqId,
      is_handshake_response: false,
      data: {
        history: updates,
        total: updates.length,
      }
    });
  }

  private async handlePeersList(
    socket: AuthenticatedSIOSocket,
    args: any,
    seqId: string,
  ) {
    if (!socket.authenticated || !socket.documentId || !socket.sessionDid) {
      this.sendError(socket, seqId, 'Not authenticated or session not found', 401);
      return;
    }

    const documentId = args.documentId || socket.documentId;
    const session = await sessionManager.getSession(documentId, socket.sessionDid);
    // const sessionDid = session?.sessionDid;
    // if (!sessionDid) {
    //   this.sendError(socket, seqId, 'Session not found', 404);
    //   return;
    // }
    const peers = session?.clients;

    this.sendMessage(socket, {
      status: true,
      statusCode: 200,
      seqId,
      is_handshake_response: false,
      data: {
        peers: Array.from(peers || []),
      }
    });
  }

  private async handleAwareness(
    socket: AuthenticatedSIOSocket,
    args: any,
    seqId: string,
  ) {
    if (!socket.authenticated || !socket.documentId || !socket.sessionDid) {
      this.sendError(socket, seqId, 'Not authenticated or session not found', 401);
      return;
    }

    const documentId = args.documentId || socket.documentId;
    const { data } = args;

    await this.broadcastToDocument(
      documentId,
      socket.sessionDid,
      {
        type: 'AWARENESS_UPDATE',
        event_type: 'AWARENESS_UPDATE',
        event: {
          data,
          roomId: documentId,
        },
      },
      socket.clientId,
    );

    this.sendMessage(socket, {
      status: true,
      statusCode: 200,
      seqId,
      is_handshake_response: false,
      data: {
        message: 'Awareness update broadcasted',
      },
    });
  }

  private async handleTerminateSession(
    socket: AuthenticatedSIOSocket,
    args: any,
    seqId: string,
  ) {
    const { documentId, ownerToken, ownerAddress, contractAddress, sessionDid } = args;
    console.log(`Terminating session. ${documentId}`);

    if (!sessionDid) {
      this.sendError(socket, seqId, "Session DID is required", 400);
      return;
    }

    const session = await sessionManager.getSession(documentId, sessionDid);
    if (!session) {
      this.sendError(socket, seqId, "Session not found", 404);
      return;
    }

    const ownerDid = await authService.verifyOwnerToken(ownerToken, contractAddress, ownerAddress);
    if (ownerDid !== session.ownerDid) {
      this.sendError(socket, seqId, 'Unauthorized', 401);
      return;
    }

    await this.broadcastToDynos(
      documentId,
      session.sessionDid,
      {
        type: 'SESSION_TERMINATED',
        event_type: 'SESSION_TERMINATED',
        event: {
          data: null,
          roomId: documentId,
        },
      },
      socket.clientId,
    );

    await sessionManager.terminateSession(documentId, session.sessionDid);
    this.sendMessage(socket, {
      status: true,
      statusCode: 200,
      seqId,
      is_handshake_response: false,
      data: { message: 'Session terminated' },
    });
  }

  private async broadcastToDynos(
    documentId: string,
    sessionDid: string,
    event: SIOSocketEvent,
    excludeClientId?: string,
  ) {
    await sessionManager.broadcastToAllDynos(documentId, sessionDid, event, excludeClientId);
  }

  private sendError(
    socket: AuthenticatedSIOSocket,
    seqId: string | null,
    error: string,
    statusCode: number,
  ) {
    this.sendMessage(socket, {
      status: false,
      statusCode,
      seqId,
      is_handshake_response: false,
      err: error,
    });
  }

  // TODO: what does this function name even mean? broadcast to document? ehh?
  private async broadcastToDocument(
    documentId: string,
    sessionDid: string,
    event: SIOSocketEvent,
    excludeClientId?: string,
  ) {
    // Only broadcast to clients connected to this dyno (for document content)
    const sessionKey = `${documentId}__${sessionDid}`;
    const localSession = sessionManager["inMemorySessions"].get(sessionKey);

    if (!localSession) { return; }

    const message = JSON.stringify(event);

    // Broadcast only to local clients 
    // TODO: what do you mean local clients? What other kinds of clients are there?
    localSession.clients.forEach((clientId: string) => {
      if (clientId === excludeClientId) {
        return;
      }
      const clientSockConn = this.connections.get(clientId);
      if (clientSockConn && clientSockConn.connected) {
        clientSockConn.send(message);
      }
    });
  }

  private sendMessage(
    socket: AuthenticatedSIOSocket,
    response: SIOSocketResponse
  ) {
    console.log(Object.keys(socket));
    // check fields of socket here.
    // check if ready state exists
    console.log(`authenticated: ${socket.authenticated}`);
    console.log(`connected: ${socket.connected}`);
    if (socket.connected) {
      // console.log(`response is: ${JSON.stringify(response)}`)
      socket.send(JSON.stringify(response));
    }
  }
}

export const socketIOManager = new SocketIOManager();
