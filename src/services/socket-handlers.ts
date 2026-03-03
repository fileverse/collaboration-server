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
  ErrorCode,
} from "../types/index";
import { requireAuth } from "./auth-middleware";
import { authService } from "./auth";
import { mongodbStore } from "./mongodb-store";
import { sessionManager } from "./session-manager";
import { Hex, isAddress } from "viem";
import type { SocketHandlerDeps } from "./socket-handlers.deps";

function validateHexAddress(address: string | undefined, fieldName: string): address is Hex {
  if (!address || !isAddress(address)) {
    return false;
  }
  return true;
}

export function getRoomName(documentId: string, sessionDid: string): string {
  return `session::${documentId}__${sessionDid}`;
}

const defaultDeps: SocketHandlerDeps = {
  authService,
  sessionManager,
};

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
    socket.on("/documents/awareness", (args) => handleAwareness(io, socket, args));
    socket.on("/documents/terminate", (args, callback) =>
      handleTerminateSession(defaultDeps, io, socket, args, callback)
    );

    // Disconnection handling
    socket.on("disconnecting", () => handleDisconnecting(defaultDeps, socket));
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
      return callback({
        status: false,
        statusCode: 400,
        error: "Collaboration token is required",
        errorCode: ErrorCode.AUTH_TOKEN_MISSING,
      });
    }

    if (!documentId) {
      return callback({
        status: false,
        statusCode: 400,
        error: "Document ID is required",
        errorCode: ErrorCode.DOCUMENT_ID_MISSING,
      });
    }

    if (!sessionDid) {
      return callback({
        status: false,
        statusCode: 400,
        error: "Session DID is required",
        errorCode: ErrorCode.SESSION_DID_MISSING,
      });
    }

    const existingSession = await sessionManager.getSession(documentId, sessionDid);

    let role: "owner" | "editor";
    let sessionType: "new" | "existing";
    let roomInfo: string | undefined;

    if (!existingSession && args.ownerToken) {
      // - Setup new session (owner flow) -
      if (!args.ownerToken || !sessionDid) {
        return callback({
          status: false,
          statusCode: 400,
          error: "Document ID, owner token, and session DID are required",
          errorCode: ErrorCode.AUTH_TOKEN_MISSING,
        });
      }

      if (!validateHexAddress(args.contractAddress, "contractAddress") ||
          !validateHexAddress(args.ownerAddress, "ownerAddress")) {
        return callback({
          status: false,
          statusCode: 400,
          error: "Invalid contract address or owner address format",
          errorCode: ErrorCode.INVALID_ADDRESS,
        });
      }

      const ownerDid = await authService.verifyOwnerToken(
        args.ownerToken,
        args.contractAddress,
        args.ownerAddress
      );

      if (!ownerDid) {
        return callback({
          status: false,
          statusCode: 401,
          error: "Authentication failed",
          errorCode: ErrorCode.AUTH_TOKEN_INVALID,
        });
      }

      // Terminate other sessions with socket notification
      const otherSessions = await sessionManager.getOtherActiveSessions(
        documentId,
        ownerDid,
        sessionDid
      );
      for (const oldSession of otherSessions) {
        const oldRoomName = getRoomName(oldSession.documentId, oldSession.sessionDid);

        // Notify connected sockets before terminating
        io.to(oldRoomName).emit("/server/error", {
          errorCode: ErrorCode.SESSION_TERMINATED,
          message: "Session terminated by owner creating a new session",
          roomId: oldSession.documentId,
        });
        io.to(oldRoomName).emit("/session/terminated", {
          roomId: oldSession.documentId,
        });

        // Force-leave all sockets and reset auth
        const socketsInOldRoom = await io.in(oldRoomName).fetchSockets();
        for (const s of socketsInOldRoom) {
          s.data.authenticated = false;
          s.leave(oldRoomName);
        }

        // Now clean up DB
        await sessionManager.terminateSession(oldSession.documentId, oldSession.sessionDid);
        console.log(
          `[Auth] Terminated old session: ${oldSession.sessionDid} for document: ${documentId}`
        );
      }

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
        return callback({
          status: false,
          statusCode: 401,
          error: "Authentication failed",
          errorCode: ErrorCode.AUTH_TOKEN_INVALID,
        });
      }

      let ownerDid = null;
      if (args.ownerToken && args.ownerAddress && args.contractAddress) {
        if (!validateHexAddress(args.contractAddress, "contractAddress") ||
            !validateHexAddress(args.ownerAddress, "ownerAddress")) {
          return callback({
            status: false,
            statusCode: 400,
            error: "Invalid contract address or owner address format",
            errorCode: ErrorCode.INVALID_ADDRESS,
          });
        }
        ownerDid = await authService.verifyOwnerToken(
          args.ownerToken,
          args.contractAddress,
          args.ownerAddress
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
      return callback({
        status: false,
        statusCode: 404,
        error: "Session not found",
        errorCode: ErrorCode.SESSION_NOT_FOUND,
      });
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
      errorCode: ErrorCode.INTERNAL_ERROR,
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
      return callback({
        status: false,
        statusCode: 401,
        error: "Not authenticated or session not found",
        errorCode: ErrorCode.NOT_AUTHENTICATED,
      });
    }

    const { data, collaborationToken } = args;
    const documentId = args.documentId || socket.data.documentId;

    if (!data) {
      return callback({
        status: false,
        statusCode: 400,
        error: "Update data is required",
        errorCode: ErrorCode.UPDATE_DATA_MISSING,
      });
    }

    const session = await sessionManager.getRuntimeSession(documentId, socket.data.sessionDid);
    const sessionDid = session?.sessionDid;

    if (!sessionDid) {
      return callback({
        status: false,
        statusCode: 404,
        error: "Session not found",
        errorCode: ErrorCode.SESSION_NOT_FOUND,
      });
    }

    const isVerified = await authService.verifyCollaborationToken(
      collaborationToken,
      sessionDid,
      documentId
    );

    if (!isVerified) {
      return callback({
        status: false,
        statusCode: 401,
        error: "Authentication failed",
        errorCode: ErrorCode.AUTH_TOKEN_INVALID,
      });
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
      errorCode: ErrorCode.INTERNAL_ERROR,
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
      return callback({
        status: false,
        statusCode: 401,
        error: "Not authenticated or session not found",
        errorCode: ErrorCode.NOT_AUTHENTICATED,
      });
    }

    if (socket.data.role !== "owner") {
      return callback({
        status: false,
        statusCode: 403,
        error: "Only owners can create commits",
        errorCode: ErrorCode.COMMIT_UNAUTHORIZED,
      });
    }

    const { updates, cid, ownerToken, ownerAddress, contractAddress } = args;
    const documentId = args.documentId || socket.data.documentId;

    const session = await sessionManager.getRuntimeSession(documentId, socket.data.sessionDid);
    const sessionDid = session?.sessionDid;

    if (!sessionDid) {
      return callback({
        status: false,
        statusCode: 404,
        error: "Session not found",
        errorCode: ErrorCode.SESSION_NOT_FOUND,
      });
    }

    if (!updates || !Array.isArray(updates) || !cid) {
      return callback({
        status: false,
        statusCode: 400,
        error: "Updates array and CID are required",
        errorCode: ErrorCode.COMMIT_MISSING_DATA,
      });
    }

    if (!validateHexAddress(contractAddress, "contractAddress") ||
        !validateHexAddress(ownerAddress, "ownerAddress")) {
      return callback({
        status: false,
        statusCode: 400,
        error: "Invalid contract address or owner address format",
        errorCode: ErrorCode.INVALID_ADDRESS,
      });
    }

    const isVerified = await authService.verifyOwnerToken(
      ownerToken,
      contractAddress,
      ownerAddress
    );

    if (!isVerified) {
      return callback({
        status: false,
        statusCode: 401,
        error: "Authentication failed",
        errorCode: ErrorCode.AUTH_TOKEN_INVALID,
      });
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
      errorCode: ErrorCode.INTERNAL_ERROR,
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
      return callback({
        status: false,
        statusCode: 401,
        error: "Not authenticated",
        errorCode: ErrorCode.NOT_AUTHENTICATED,
      });
    }

    const documentId = args.documentId || socket.data.documentId;
    const { offset = 0, limit = 10, sort = "desc" } = args;

    const filterParams = { documentId, sessionDid: socket.data.sessionDid };
    const [commits, total] = await Promise.all([
      mongodbStore.getCommitsByDocument(filterParams, { offset, limit, sort }),
      mongodbStore.countCommitsByDocument(filterParams),
    ]);

    callback({
      status: true,
      statusCode: 200,
      data: {
        history: commits,
        total,
      },
    });
  } catch (error) {
    console.error("Error in commit history handler:", error);
    callback({
      status: false,
      statusCode: 500,
      error: "Internal server error",
      errorCode: ErrorCode.INTERNAL_ERROR,
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
      return callback({
        status: false,
        statusCode: 401,
        error: "Not authenticated",
        errorCode: ErrorCode.NOT_AUTHENTICATED,
      });
    }

    const documentId = args.documentId || socket.data.documentId;
    const { offset = 0, limit = 100, sort = "desc", filters = {} } = args;

    const filterParams = { documentId, sessionDid: socket.data.sessionDid };
    const [updates, total] = await Promise.all([
      mongodbStore.getUpdatesByDocument(filterParams, { offset, limit, sort, committed: filters.committed }),
      mongodbStore.countUpdatesByDocument(filterParams, { committed: filters.committed }),
    ]);

    callback({
      status: true,
      statusCode: 200,
      data: {
        history: updates,
        total,
      },
    });
  } catch (error) {
    console.error("Error in update history handler:", error);
    callback({
      status: false,
      statusCode: 500,
      error: "Internal server error",
      errorCode: ErrorCode.INTERNAL_ERROR,
    });
  }
}

export async function handlePeersList(
  io: AppServer,
  socket: AppSocket,
  args: PeersListArgs,
  callback: (response: AckResponse<{ peers: string[] }>) => void
): Promise<void> {
  try {
    if (!requireAuth(socket)) {
      return callback({
        status: false,
        statusCode: 401,
        error: "Not authenticated or session not found",
        errorCode: ErrorCode.NOT_AUTHENTICATED,
      });
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
      errorCode: ErrorCode.INTERNAL_ERROR,
    });
  }
}

export async function handleAwareness(
  io: AppServer,
  socket: AppSocket,
  args: AwarenessArgs,
): Promise<void> {
  try {
    if (!requireAuth(socket)) {
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
  } catch (error) {
    console.error("Error in awareness handler:", error);
  }
}

export async function handleTerminateSession(
  deps: SocketHandlerDeps,
  io: AppServer,
  socket: AppSocket,
  args: TerminateSessionArgs,
  callback: (response: AckResponse<{ message: string }>) => void
): Promise<void> {
  try {
    const { authService, sessionManager } = deps;
    const { documentId, sessionDid, ownerToken, ownerAddress, contractAddress } = args;

    console.log("TERMINATING SESSION", documentId);

    if (!sessionDid) {
      return callback({
        status: false,
        statusCode: 400,
        error: "Session DID is required",
        errorCode: ErrorCode.SESSION_DID_MISSING,
      });
    }

    const session = await sessionManager.getSession(documentId, sessionDid);
    if (!session) {
      return callback({
        status: false,
        statusCode: 404,
        error: "Session not found",
        errorCode: ErrorCode.SESSION_NOT_FOUND,
      });
    }

    if (!validateHexAddress(contractAddress, "contractAddress") ||
        !validateHexAddress(ownerAddress, "ownerAddress")) {
      return callback({
        status: false,
        statusCode: 400,
        error: "Invalid contract address or owner address format",
        errorCode: ErrorCode.INVALID_ADDRESS,
      });
    }

    const ownerDid = await authService.verifyOwnerToken(
      ownerToken,
      contractAddress,
      ownerAddress
    );

    if (ownerDid !== session.ownerDid) {
      return callback({
        status: false,
        statusCode: 401,
        error: "Unauthorized",
        errorCode: ErrorCode.AUTH_TOKEN_INVALID,
      });
    }

    const roomName = getRoomName(documentId, session.sessionDid);

    // 1. Capture all sockets in room before any mutations
    const socketsInRoom = await io.in(roomName).fetchSockets();

    // 2. Broadcast termination to all in room (excluding sender)
    socket.to(roomName).emit("/session/terminated", {
      roomId: documentId,
    });

    // 3. Deauth and force-leave all sockets (blocks new handlers)
    for (const s of socketsInRoom) {
      s.data.authenticated = false;
      s.leave(roomName);
    }

    // 4. Deactivate session in memory (prevents new handlers from finding it)
    await sessionManager.deactivateSession(documentId, session.sessionDid);

    // 5. Clean up DB
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
      errorCode: ErrorCode.INTERNAL_ERROR,
    });
  }
}

export async function handleDisconnecting(
  deps: SocketHandlerDeps,
  socket: AppSocket
): Promise<void> {
  try {
    const { sessionManager } = deps;
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