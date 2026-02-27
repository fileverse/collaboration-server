import { v4 as uuidv4 } from "uuid";
import {
  AckResponse,
  AuthArgs,
  AuthResponseData,
  DocumentUpdateArgs,
  DocumentUpdateResponseData,
  DocumentCommitArgs,
  DocumentCommitResponseData,
  CommitHistoryArgs,
  UpdateHistoryArgs,
  PeersListArgs,
  AwarenessArgs,
  TerminateSessionArgs,
  DocumentCommit,
  DocumentUpdate,
  AppServer,
  AppSocket,
} from "../types/index";
import { requireAuth } from "./auth-middleware";
import { authService } from "./auth";
import { mongodbStore } from "./mongodb-store";
import { sessionManager } from "./session-manager";
import { Hex } from "viem";
import type { SocketHandlerDeps } from "./socket-handlers.deps";

const defaultDeps: SocketHandlerDeps = {
  authService,
  sessionManager,
};

function getRoomName(documentId: string, sessionDid: string): string {
  return `session::${documentId}__${sessionDid}`;
}

export function registerEventHandlers(io: AppServer): void {
  io.on("connection", (socket: AppSocket) => {
    console.log(`New Socket.IO connection: ${socket.id}`);

    // Send handshake immediately
    socket.emit("/server/handshake", {
      server_did: authService.getServerDid(),
      message: "Connected to collaboration server",
    });

    // Register event handlers
    socket.on("/auth", (args, callback) => handleAuth(io, socket, args, callback));
    socket.on("/documents/update", (args, callback) => handleDocumentUpdate(io, socket, args, callback));
    socket.on("/documents/commit", (args, callback) => handleDocumentCommit(socket, args, callback));
    socket.on("/documents/commit/history", (args, callback) => handleCommitHistory(socket, args, callback));
    socket.on("/documents/update/history", (args, callback) => handleUpdateHistory(socket, args, callback));
    socket.on("/documents/peers/list", (args, callback) => handlePeersList(io, socket, args, callback));
    socket.on("/documents/awareness", (args, callback) => handleAwareness(io, socket, args, callback));
    socket.on("/documents/terminate", (args, callback) =>
      handleTerminateSession(defaultDeps, io, socket, args, callback)
    );

    // Disconnection handling
    socket.on("disconnecting", () => handleDisconnecting(socket));
    socket.on("disconnect", (reason) => {
      console.log(`Socket disconnected: ${socket.id}, reason: ${reason}`);
    });
    socket.on("error", (error) => {
      console.error(`Socket error for ${socket.id}:`, error);
    });
  });
}

async function handleAuth(
  io: AppServer,
  socket: AppSocket,
  args: AuthArgs,
  callback: (response: AckResponse<AuthResponseData>) => void
): Promise<void> {
  try {
    const { documentId, collaborationToken, sessionDid } = args;

    if (!collaborationToken) {
      callback({
        status: false,
        statusCode: 400,
        error: "Collaboration token is required",
      });
      return;
    }

    if (!documentId) {
      callback({
        status: false,
        statusCode: 400,
        error: "Document ID is required",
      });
      return;
    }

    if (!sessionDid) {
      callback({
        status: false,
        statusCode: 400,
        error: "Session DID is required",
      });
      return;
    }

    const existingSession = await sessionManager.getSession(documentId, sessionDid);

    let role: "owner" | "editor";
    let sessionType: "new" | "existing";
    let roomInfo: string | undefined;

    if (!existingSession && args.ownerToken) {
      // - Setup new session (owner flow) -
      if (!args.ownerToken || !sessionDid) {
        callback({
          status: false,
          statusCode: 400,
          error: "Document ID, owner token, and session DID are required",
        });
        return;
      }

      const ownerDid = await authService.verifyOwnerToken(
        args.ownerToken,
        args.contractAddress as Hex,
        args.ownerAddress as Hex
      );

      if (!ownerDid) {
        callback({
          status: false,
          statusCode: 401,
          error: "Authentication failed",
        });
        return;
      }

      await sessionManager.terminateOtherExistingSessions(documentId, ownerDid);

      await sessionManager.createSession({
        documentId,
        sessionDid,
        ownerDid,
        roomInfo: args.roomInfo,
      });

      role = "owner";
      sessionType = "new";
      roomInfo = args.roomInfo;
    } else if (existingSession) {
      // - Join existing session -
      const userDid = await authService.verifyCollaborationToken(
        collaborationToken,
        existingSession.sessionDid,
        documentId
      );

      if (!userDid) {
        callback({
          status: false,
          statusCode: 401,
          error: "Authentication failed",
        });
        return;
      }

      let ownerDid = null;
      if (args.ownerToken && args.ownerAddress && args.contractAddress) {
        ownerDid = await authService.verifyOwnerToken(
          args.ownerToken,
          args.contractAddress as Hex,
          args.ownerAddress as Hex
        );
      }

      role = ownerDid === existingSession.ownerDid ? "owner" : "editor";

      if (role === "owner" && args.roomInfo) {
        await sessionManager.updateRoomInfo(
          documentId,
          existingSession.sessionDid,
          existingSession.ownerDid,
          args.roomInfo
        );
      }

      sessionType = "existing";
      roomInfo = existingSession.roomInfo;
    } else {
      callback({
        status: false,
        statusCode: 404,
        error: "Session not found",
      });
      return;
    }

    // Set socket data
    socket.data.authenticated = true;
    socket.data.documentId = documentId;
    socket.data.sessionDid = sessionDid;
    socket.data.role = role;

    // Join the Socket.IO room
    const roomName = getRoomName(documentId, sessionDid);
    socket.join(roomName);

    // Track in session manager (for session lifecycle / deactivation logic)
    await sessionManager.addClientToSession(documentId, sessionDid, socket.id);

    console.log(sessionType === "new" ? "SETUP DONE" : "JOINED SESSION", documentId, role);

    // Broadcast membership change to others in the room
    socket.to(roomName).emit("/room/membership_change", {
      action: "user_joined",
      user: { role },
      roomId: documentId,
    });

    callback({
      status: true,
      statusCode: 200,
      data: {
        message: "Authentication successful",
        role,
        sessionType,
        roomInfo,
      },
    });
  } catch (error) {
    console.error("Error in auth handler:", error);
    callback({
      status: false,
      statusCode: 500,
      error: "Internal server error",
    });
  }
}

async function handleDocumentUpdate(
  io: AppServer,
  socket: AppSocket,
  args: DocumentUpdateArgs,
  callback: (response: AckResponse<DocumentUpdateResponseData>) => void
): Promise<void> {
  try {
    if (!requireAuth(socket)) {
      callback({
        status: false,
        statusCode: 401,
        error: "Not authenticated or session not found",
      });
      return;
    }

    const { data, collaborationToken } = args;
    const documentId = args.documentId || socket.data.documentId;

    if (!data) {
      callback({
        status: false,
        statusCode: 400,
        error: "Update data is required",
      });
      return;
    }

    const session = await sessionManager.getRuntimeSession(documentId, socket.data.sessionDid);
    const sessionDid = session?.sessionDid;

    if (!sessionDid) {
      callback({
        status: false,
        statusCode: 404,
        error: "Session not found",
      });
      return;
    }

    const isVerified = await authService.verifyCollaborationToken(
      collaborationToken,
      sessionDid,
      documentId
    );

    if (!isVerified) {
      callback({
        status: false,
        statusCode: 401,
        error: "Authentication failed",
      });
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

    // Broadcast to room, excluding sender
    const roomName = getRoomName(documentId, socket.data.sessionDid);
    socket.to(roomName).emit("/document/content_update", {
      id: update.id,
      data: update.data,
      createdAt: update.createdAt,
      roomId: documentId,
    });

    callback({
      status: true,
      statusCode: 200,
      data: {
        id: update.id,
        documentId: update.documentId,
        data: update.data,
        updateType: update.updateType,
        commitCid: update.commitCid,
        createdAt: update.createdAt,
      },
    });
  } catch (error) {
    console.error("Error in document update handler:", error);
    callback({
      status: false,
      statusCode: 500,
      error: "Internal server error",
    });
  }
}

async function handleDocumentCommit(
  socket: AppSocket,
  args: DocumentCommitArgs,
  callback: (response: AckResponse<DocumentCommitResponseData>) => void
): Promise<void> {
  try {
    if (!requireAuth(socket)) {
      callback({
        status: false,
        statusCode: 401,
        error: "Not authenticated or session not found",
      });
      return;
    }

    if (socket.data.role !== "owner") {
      callback({
        status: false,
        statusCode: 403,
        error: "Only owners can create commits",
      });
      return;
    }

    const { updates, cid, ownerToken, ownerAddress, contractAddress } = args;
    const documentId = args.documentId || socket.data.documentId;

    const session = await sessionManager.getRuntimeSession(documentId, socket.data.sessionDid);
    const sessionDid = session?.sessionDid;

    if (!sessionDid) {
      callback({
        status: false,
        statusCode: 404,
        error: "Session not found",
      });
      return;
    }

    if (!updates || !Array.isArray(updates) || !cid) {
      callback({
        status: false,
        statusCode: 400,
        error: "Updates array and CID are required",
      });
      return;
    }

    const isVerified = await authService.verifyOwnerToken(
      ownerToken,
      contractAddress as Hex,
      ownerAddress as Hex
    );

    if (!isVerified) {
      callback({
        status: false,
        statusCode: 401,
        error: "Authentication failed",
      });
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

    callback({
      status: true,
      statusCode: 200,
      data: {
        cid: commit.cid,
        createdAt: commit.createdAt,
        documentId: commit.documentId,
        updates: commit.updates,
      },
    });
  } catch (error) {
    console.error("Error in document commit handler:", error);
    callback({
      status: false,
      statusCode: 500,
      error: "Internal server error",
    });
  }
}

async function handleCommitHistory(
  socket: AppSocket,
  args: CommitHistoryArgs,
  callback: (response: AckResponse<{ history: DocumentCommit[]; total: number }>) => void
): Promise<void> {
  try {
    if (!requireAuth(socket)) {
      callback({
        status: false,
        statusCode: 401,
        error: "Not authenticated",
      });
      return;
    }

    const documentId = args.documentId || socket.data.documentId;
    const { offset = 0, limit = 10, sort = "desc" } = args;

    const commits = await mongodbStore.getCommitsByDocument(
      { documentId, sessionDid: socket.data.sessionDid },
      { offset, limit, sort }
    );

    callback({
      status: true,
      statusCode: 200,
      data: {
        history: commits,
        total: commits.length,
      },
    });
  } catch (error) {
    console.error("Error in commit history handler:", error);
    callback({
      status: false,
      statusCode: 500,
      error: "Internal server error",
    });
  }
}

async function handleUpdateHistory(
  socket: AppSocket,
  args: UpdateHistoryArgs,
  callback: (response: AckResponse<{ history: DocumentUpdate[]; total: number }>) => void
): Promise<void> {
  try {
    if (!requireAuth(socket)) {
      callback({
        status: false,
        statusCode: 401,
        error: "Not authenticated",
      });
      return;
    }

    const documentId = args.documentId || socket.data.documentId;
    const { offset = 0, limit = 100, sort = "desc", filters = {} } = args;

    const updates = await mongodbStore.getUpdatesByDocument(
      { documentId, sessionDid: socket.data.sessionDid },
      { offset, limit, sort, committed: filters.committed }
    );

    callback({
      status: true,
      statusCode: 200,
      data: {
        history: updates,
        total: updates.length,
      },
    });
  } catch (error) {
    console.error("Error in update history handler:", error);
    callback({
      status: false,
      statusCode: 500,
      error: "Internal server error",
    });
  }
}

async function handlePeersList(
  io: AppServer,
  socket: AppSocket,
  args: PeersListArgs,
  callback: (response: AckResponse<{ peers: string[] }>) => void
): Promise<void> {
  try {
    if (!requireAuth(socket)) {
      callback({
        status: false,
        statusCode: 401,
        error: "Not authenticated or session not found",
      });
      return;
    }

    const documentId = args.documentId || socket.data.documentId;
    const roomName = getRoomName(documentId, socket.data.sessionDid);

    // Use Socket.IO's native room tracking for accurate peer list
    const sockets = await io.in(roomName).fetchSockets();
    const peers = sockets.map((s) => s.id);

    callback({
      status: true,
      statusCode: 200,
      data: { peers },
    });
  } catch (error) {
    console.error("Error in peers list handler:", error);
    callback({
      status: false,
      statusCode: 500,
      error: "Internal server error",
    });
  }
}

async function handleAwareness(
  io: AppServer,
  socket: AppSocket,
  args: AwarenessArgs,
  callback: (response: AckResponse<{ message: string }>) => void
): Promise<void> {
  try {
    if (!requireAuth(socket)) {
      callback({
        status: false,
        statusCode: 401,
        error: "Not authenticated or session not found",
      });
      return;
    }

    const documentId = args.documentId || socket.data.documentId;
    const { data } = args;

    // Broadcast awareness update to room, excluding sender
    const roomName = getRoomName(documentId, socket.data.sessionDid);
    socket.to(roomName).emit("/document/awareness_update", {
      data,
      roomId: documentId,
    });

    callback({
      status: true,
      statusCode: 200,
      data: { message: "Awareness update broadcasted" },
    });
  } catch (error) {
    console.error("Error in awareness handler:", error);
    callback({
      status: false,
      statusCode: 500,
      error: "Internal server error",
    });
  }
}

export async function handleTerminateSession(
  deps: SocketHandlerDeps,
  io: AppServer,
  socket: AppSocket,
  args: TerminateSessionArgs,
  callback: (response: AckResponse<{ message: string }>) => void
): Promise<void> {
  const { authService, sessionManager } = deps;

  try {
    const { documentId, sessionDid, ownerToken, ownerAddress, contractAddress } = args;

    console.log("TERMINATING SESSION", documentId);

    if (!sessionDid) {
      callback({
        status: false,
        statusCode: 400,
        error: "Session DID is required",
      });
      return;
    }

    const session = await sessionManager.getSession(documentId, sessionDid);
    if (!session) {
      callback({
        status: false,
        statusCode: 404,
        error: "Session not found",
      });
      return;
    }

    const ownerDid = await authService.verifyOwnerToken(
      ownerToken,
      contractAddress as Hex,
      ownerAddress as Hex
    );

    if (ownerDid !== session.ownerDid) {
      callback({
        status: false,
        statusCode: 401,
        error: "Unauthorized",
      });
      return;
    }

    const roomName = getRoomName(documentId, session.sessionDid);

    // Broadcast termination to all in room (excluding sender)
    socket.to(roomName).emit("/session/terminated", {
      roomId: documentId,
    });

    // Force all sockets to leave the room and reset auth
    const socketsInRoom = await io.in(roomName).fetchSockets();
    for (const s of socketsInRoom) {
      s.leave(roomName);
      s.data.authenticated = false;
    }

    await sessionManager.terminateSession(documentId, session.sessionDid);

    callback({
      status: true,
      statusCode: 200,
      data: { message: "Session terminated" },
    });
  } catch (error) {
    console.error("Error in terminate session handler:", error);
    callback({
      status: false,
      statusCode: 500,
      error: "Internal server error",
    });
  }
}

async function handleDisconnecting(
  socket: AppSocket
): Promise<void> {
  try {
    if (!socket.data.authenticated || !socket.data.documentId || !socket.data.sessionDid) {
      return;
    }

    const roomName = getRoomName(socket.data.documentId, socket.data.sessionDid);

    // Broadcast departure BEFORE leaving rooms
    // (socket is still in its rooms during "disconnecting" event)
    socket.to(roomName).emit("/room/membership_change", {
      action: "user_left",
      user: { role: socket.data.role },
      roomId: socket.data.documentId,
    });

    // Remove from session tracking (handles deactivation if last client)
    await sessionManager.removeClientFromSession(
      socket.data.documentId,
      socket.data.sessionDid,
      socket.id
    );
  } catch (error) {
    console.error(`Error during disconnection cleanup for ${socket.id}:`, error);
  }
}