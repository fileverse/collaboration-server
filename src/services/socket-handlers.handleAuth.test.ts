import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleAuth, getRoomName } from "./socket-handlers";
import { AppServer, AppSocket, AuthArgs, ErrorCode } from "../types";
import type { SocketHandlerDeps } from "./socket-handlers.deps";

function createFakeIO(options?: {
  broadcastOperator?: { emit: ReturnType<typeof vi.fn> };
  fetchSockets?: ReturnType<typeof vi.fn>;
}): AppServer {
  const roomBroadcastOperator = options?.broadcastOperator ?? { emit: vi.fn() };
  const fetchSockets = options?.fetchSockets ?? vi.fn().mockResolvedValue([]);

  return {
    to: vi.fn(() => roomBroadcastOperator),
    in: vi.fn(() => ({ fetchSockets })),
  } as unknown as AppServer;
}

function createFakeSocket(
  broadcastOperator?: { emit: ReturnType<typeof vi.fn> },
  dataOverrides?: Partial<{
    authenticated: boolean;
    documentId: string;
    sessionDid: string;
    role: "owner" | "editor";
  }>
): AppSocket {
  const toReturn = broadcastOperator ?? { emit: vi.fn() };
  const defaultData = {
    authenticated: false,
    documentId: "",
    sessionDid: "",
    role: "editor" as const,
  };
  const data = { ...defaultData, ...dataOverrides };

  return {
    id: "socket-1",
    data,
    to: vi.fn(() => toReturn),
    join: vi.fn(),
  } as unknown as AppSocket;
}

describe("handleAuth", () => {
  const fakeAuthService = {
    verifyOwnerToken: vi.fn(),
    verifyCollaborationToken: vi.fn(),
    getServerDid: vi.fn(),
  };
  const fakeSessionManager = {
    getSession: vi.fn(),
    getOtherActiveSessions: vi.fn(),
    terminateSession: vi.fn(),
    createSession: vi.fn(),
    updateRoomInfo: vi.fn(),
    addClientToSession: vi.fn(),
  };
  const fakeMongoDBStore = {} as any;

  const deps: SocketHandlerDeps = {
    authService: fakeAuthService as any,
    sessionManager: fakeSessionManager as any,
    mongodbStore: fakeMongoDBStore,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when collaborationToken is missing", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket();
    const fakeArgs: AuthArgs = {
      documentId: "doc-1",
      sessionDid: "session-1",
      collaborationToken: "" as any,
    };
    const callback = vi.fn();

    await handleAuth(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 400,
      error: "Collaboration token is required",
      errorCode: ErrorCode.AUTH_TOKEN_MISSING,
    });
  });

  it("returns 400 when documentId is missing", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket();
    const fakeArgs: AuthArgs = {
      documentId: "" as any,
      sessionDid: "session-1",
      collaborationToken: "collab-token",
    };
    const callback = vi.fn();

    await handleAuth(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 400,
      error: "Document ID is required",
      errorCode: ErrorCode.DOCUMENT_ID_MISSING,
    });
  });

  it("returns 400 when sessionDid is missing", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket();
    const fakeArgs: AuthArgs = {
      documentId: "doc-1",
      sessionDid: "" as any,
      collaborationToken: "collab-token",
    };
    const callback = vi.fn();

    await handleAuth(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 400,
      error: "Session DID is required",
      errorCode: ErrorCode.SESSION_DID_MISSING,
    });
  });

  it("creates a new owner session when no existing session and ownerToken is provided", async () => {
    const fakeIO = createFakeIO();
    const fakeBroadcastOperator = { emit: vi.fn() };
    const fakeSocket = createFakeSocket(fakeBroadcastOperator);
    const fakeArgs: AuthArgs = {
      documentId: "doc-1",
      sessionDid: "session-1",
      collaborationToken: "collab-token",
      ownerToken: "owner-token",
      ownerAddress: "0x0000000000000000000000000000000000000001",
      contractAddress: "0x0000000000000000000000000000000000000002",
      roomInfo: "room-info",
    };
    const callback = vi.fn();

    fakeSessionManager.getSession.mockResolvedValue(undefined);
    fakeAuthService.verifyOwnerToken.mockResolvedValue("owner-did");
    fakeSessionManager.getOtherActiveSessions.mockResolvedValue([]);
    fakeSessionManager.createSession.mockResolvedValue(undefined);
    fakeSessionManager.addClientToSession.mockResolvedValue(undefined);

    await handleAuth(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(fakeSessionManager.getSession).toHaveBeenCalledWith(
      fakeArgs.documentId,
      fakeArgs.sessionDid
    );
    expect(fakeAuthService.verifyOwnerToken).toHaveBeenCalledWith(
      fakeArgs.ownerToken,
      fakeArgs.contractAddress,
      fakeArgs.ownerAddress
    );
    expect(fakeSessionManager.getOtherActiveSessions).toHaveBeenCalledWith(
      fakeArgs.documentId,
      "owner-did",
      fakeArgs.sessionDid,
    );
    expect(fakeSessionManager.createSession).toHaveBeenCalledWith({
      documentId: fakeArgs.documentId,
      sessionDid: fakeArgs.sessionDid,
      ownerDid: "owner-did",
      roomInfo: fakeArgs.roomInfo,
    });

    expect(fakeSocket.data.authenticated).toBe(true);
    expect(fakeSocket.data.documentId).toBe(fakeArgs.documentId);
    expect(fakeSocket.data.sessionDid).toBe(fakeArgs.sessionDid);
    expect(fakeSocket.data.role).toBe("owner");

    const roomName = getRoomName(fakeArgs.documentId, fakeArgs.sessionDid);
    expect(fakeSocket.join).toHaveBeenCalledWith(roomName);
    expect(fakeSessionManager.addClientToSession).toHaveBeenCalledWith(
      fakeArgs.documentId,
      fakeArgs.sessionDid,
      fakeSocket.id
    );
    expect(fakeSocket.to).toHaveBeenCalledWith(roomName);
    expect(fakeBroadcastOperator.emit).toHaveBeenCalledWith("/room/membership_change", {
      action: "user_joined",
      user: { role: "owner" },
      roomId: fakeArgs.documentId,
    });

    expect(callback).toHaveBeenCalledWith({
      status: true,
      statusCode: 200,
      data: {
        message: "Authentication successful",
        role: "owner",
        sessionType: "new",
        roomInfo: fakeArgs.roomInfo,
      },
    });
  });

  it("creates a new owner session and terminates other active sessions when they exist", async () => {
    const fakeRoomBroadcastOperator = { emit: vi.fn() };
    const fetchSockets = vi.fn();
    const fakeIO = createFakeIO({ broadcastOperator: fakeRoomBroadcastOperator, fetchSockets });

    const fakeBroadcastOperator = { emit: vi.fn() };
    const fakeSocket = createFakeSocket(fakeBroadcastOperator);
    const fakeArgs: AuthArgs = {
      documentId: "doc-1",
      sessionDid: "session-1",
      collaborationToken: "collab-token",
      ownerToken: "owner-token",
      ownerAddress: "0x0000000000000000000000000000000000000001",
      contractAddress: "0x0000000000000000000000000000000000000002",
      roomInfo: "room-info",
    };
    const callback = vi.fn();

    const otherSessions = [
      { documentId: fakeArgs.documentId, sessionDid: "old-session-1" },
      { documentId: fakeArgs.documentId, sessionDid: "old-session-2" },
    ];

    const oldRoomName1 = getRoomName(fakeArgs.documentId, otherSessions[0].sessionDid);
    const oldRoomName2 = getRoomName(fakeArgs.documentId, otherSessions[1].sessionDid);
    const oldSocket1 = createFakeSocket(undefined, { authenticated: true }) as any;
    const oldSocket2 = createFakeSocket(undefined, { authenticated: true }) as any;
    oldSocket1.leave = vi.fn();
    oldSocket2.leave = vi.fn();

    fetchSockets
      .mockResolvedValueOnce([oldSocket1])
      .mockResolvedValueOnce([oldSocket2]);

    fakeSessionManager.getSession.mockResolvedValue(undefined);
    fakeAuthService.verifyOwnerToken.mockResolvedValue("owner-did");
    fakeSessionManager.getOtherActiveSessions.mockResolvedValue(otherSessions);
    fakeSessionManager.terminateSession.mockResolvedValue(undefined);
    fakeSessionManager.createSession.mockResolvedValue(undefined);
    fakeSessionManager.addClientToSession.mockResolvedValue(undefined);

    await handleAuth(deps, fakeIO, fakeSocket, fakeArgs, callback);

    // Pre-loop checks (sequence before termination loop)
    expect(fakeSessionManager.getSession).toHaveBeenCalledWith(
      fakeArgs.documentId,
      fakeArgs.sessionDid
    );
    expect(fakeAuthService.verifyOwnerToken).toHaveBeenCalledWith(
      fakeArgs.ownerToken,
      fakeArgs.contractAddress,
      fakeArgs.ownerAddress
    );
    expect(fakeSessionManager.getOtherActiveSessions).toHaveBeenCalledWith(
      fakeArgs.documentId,
      "owner-did",
      fakeArgs.sessionDid,
    );

    // First other session (old-session-1)
    expect(fakeIO.to).toHaveBeenCalledWith(oldRoomName1);
    expect(fakeRoomBroadcastOperator.emit).toHaveBeenCalledWith("/server/error", {
      errorCode: ErrorCode.SESSION_TERMINATED,
      message: "Session terminated by owner creating a new session",
      roomId: otherSessions[0].documentId,
    });
    expect(fakeIO.to).toHaveBeenCalledWith(oldRoomName1);
    expect(fakeRoomBroadcastOperator.emit).toHaveBeenCalledWith("/session/terminated", {
      roomId: otherSessions[0].documentId,
    });
    expect(fakeIO.in).toHaveBeenCalledWith(oldRoomName1);
    expect(fetchSockets).toHaveBeenCalledWith();
    expect(oldSocket1.data.authenticated).toBe(false);
    expect(oldSocket1.leave).toHaveBeenCalledWith(oldRoomName1);
    expect(fakeSessionManager.terminateSession).toHaveBeenCalledWith(
      otherSessions[0].documentId,
      otherSessions[0].sessionDid
    );

    // Second other session (old-session-2)
    expect(fakeIO.to).toHaveBeenCalledWith(oldRoomName2);
    expect(fakeRoomBroadcastOperator.emit).toHaveBeenCalledWith("/server/error", {
      errorCode: ErrorCode.SESSION_TERMINATED,
      message: "Session terminated by owner creating a new session",
      roomId: otherSessions[1].documentId,
    });
    expect(fakeIO.to).toHaveBeenCalledWith(oldRoomName2);
    expect(fakeRoomBroadcastOperator.emit).toHaveBeenCalledWith("/session/terminated", {
      roomId: otherSessions[1].documentId,
    });
    expect(fakeIO.in).toHaveBeenCalledWith(oldRoomName2);
    expect(fetchSockets).toHaveBeenCalledWith();
    expect(oldSocket2.data.authenticated).toBe(false);
    expect(oldSocket2.leave).toHaveBeenCalledWith(oldRoomName2);
    expect(fakeSessionManager.terminateSession).toHaveBeenCalledWith(
      otherSessions[1].documentId,
      otherSessions[1].sessionDid
    );

    // Aggregate call-count assertions after verifying per-iteration sequence
    // Outside if-else block
    expect(fetchSockets).toHaveBeenCalledTimes(otherSessions.length);
    expect(fakeSessionManager.terminateSession).toHaveBeenCalledTimes(otherSessions.length);

    expect(fakeSocket.data.authenticated).toBe(true);
    expect(fakeSocket.data.documentId).toBe(fakeArgs.documentId);
    expect(fakeSocket.data.sessionDid).toBe(fakeArgs.sessionDid);
    expect(fakeSocket.data.role).toBe("owner");

    const roomName = getRoomName(fakeArgs.documentId, fakeArgs.sessionDid);
    expect(fakeSocket.join).toHaveBeenCalledWith(roomName);
    expect(fakeSessionManager.addClientToSession).toHaveBeenCalledWith(
      fakeArgs.documentId,
      fakeArgs.sessionDid,
      fakeSocket.id
    );
    expect(fakeSocket.to).toHaveBeenCalledWith(roomName);
    expect(fakeBroadcastOperator.emit).toHaveBeenCalledWith("/room/membership_change", {
      action: "user_joined",
      user: { role: "owner" },
      roomId: fakeArgs.documentId,
    });

    expect(callback).toHaveBeenCalledWith({
      status: true,
      statusCode: 200,
      data: {
        message: "Authentication successful",
        role: "owner",
        sessionType: "new",
        roomInfo: fakeArgs.roomInfo,
      },
    });
  });

  it("joins an existing session as editor when collaboration token is valid", async () => {
    const fakeIO = createFakeIO();
    const fakeBroadcastOperator = { emit: vi.fn() };
    const fakeSocket = createFakeSocket(fakeBroadcastOperator);
    const fakeArgs: AuthArgs = {
      documentId: "doc-1",
      sessionDid: "session-1",
      collaborationToken: "collab-token",
    };
    const callback = vi.fn();

    const existingSession = {
      sessionDid: fakeArgs.sessionDid,
      ownerDid: "owner-did",
      roomInfo: "existing-room-info",
    };

    fakeSessionManager.getSession.mockResolvedValue(existingSession);
    fakeAuthService.verifyCollaborationToken.mockResolvedValue("user-did");
    fakeSessionManager.addClientToSession.mockResolvedValue(undefined);

    await handleAuth(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(fakeAuthService.verifyCollaborationToken).toHaveBeenCalledWith(
      fakeArgs.collaborationToken,
      existingSession.sessionDid,
      fakeArgs.documentId
    );

    const roomName = getRoomName(fakeArgs.documentId, fakeArgs.sessionDid);
    expect(fakeSocket.join).toHaveBeenCalledWith(roomName);
    expect(fakeBroadcastOperator.emit).toHaveBeenCalledWith("/room/membership_change", {
      action: "user_joined",
      user: { role: "editor" },
      roomId: fakeArgs.documentId,
    });

    expect(callback).toHaveBeenCalledWith({
      status: true,
      statusCode: 200,
      data: {
        message: "Authentication successful",
        role: "editor",
        sessionType: "existing",
        roomInfo: existingSession.roomInfo,
      },
    });
  });

  it("returns 404 when existing session is not found and no ownerToken is provided", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket();
    const fakeArgs: AuthArgs = {
      documentId: "doc-1",
      sessionDid: "session-1",
      collaborationToken: "collab-token",
    };
    const callback = vi.fn();

    fakeSessionManager.getSession.mockResolvedValue(undefined);

    await handleAuth(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 404,
      error: "Session not found",
      errorCode: ErrorCode.SESSION_NOT_FOUND,
    });
  });

  it("returns 401 when owner token verification fails in owner flow", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket();
    const fakeArgs: AuthArgs = {
      documentId: "doc-1",
      sessionDid: "session-1",
      collaborationToken: "collab-token",
      ownerToken: "owner-token",
      ownerAddress: "0x0000000000000000000000000000000000000001",
      contractAddress: "0x0000000000000000000000000000000000000002",
    };
    const callback = vi.fn();

    fakeSessionManager.getSession.mockResolvedValue(undefined);
    fakeAuthService.verifyOwnerToken.mockResolvedValue(null);

    await handleAuth(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(fakeSessionManager.getSession).toHaveBeenCalledWith(
      fakeArgs.documentId,
      fakeArgs.sessionDid
    );
    expect(fakeAuthService.verifyOwnerToken).toHaveBeenCalledWith(
      fakeArgs.ownerToken,
      fakeArgs.contractAddress,
      fakeArgs.ownerAddress
    );
    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 401,
      error: "Authentication failed",
      errorCode: ErrorCode.AUTH_TOKEN_INVALID,
    });
  });

  it("returns 401 when collaboration token verification fails for existing session", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket();
    const fakeArgs: AuthArgs = {
      documentId: "doc-1",
      sessionDid: "session-1",
      collaborationToken: "collab-token",
    };
    const callback = vi.fn();

    const existingSession = {
      sessionDid: fakeArgs.sessionDid,
      ownerDid: "owner-did",
      roomInfo: "existing-room-info",
    };

    fakeSessionManager.getSession.mockResolvedValue(existingSession);
    fakeAuthService.verifyCollaborationToken.mockResolvedValue(null);

    await handleAuth(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(fakeAuthService.verifyCollaborationToken).toHaveBeenCalledWith(
      fakeArgs.collaborationToken,
      existingSession.sessionDid,
      fakeArgs.documentId
    );
    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 401,
      error: "Authentication failed",
      errorCode: ErrorCode.AUTH_TOKEN_INVALID,
    });
  });

  it("joins existing session as owner and updates room info when owner token matches", async () => {
    const fakeIO = createFakeIO();
    const fakeBroadcastOperator = { emit: vi.fn() };
    const fakeSocket = createFakeSocket(fakeBroadcastOperator);
    const fakeArgs: AuthArgs = {
      documentId: "doc-1",
      sessionDid: "session-1",
      collaborationToken: "collab-token",
      ownerToken: "owner-token",
      ownerAddress: "0x0000000000000000000000000000000000000001",
      contractAddress: "0x0000000000000000000000000000000000000002",
      roomInfo: "new-room-info",
    };
    const callback = vi.fn();

    const existingSession = {
      sessionDid: fakeArgs.sessionDid,
      ownerDid: "owner-did",
      roomInfo: "existing-room-info",
    };

    fakeSessionManager.getSession.mockResolvedValue(existingSession);
    fakeAuthService.verifyCollaborationToken.mockResolvedValue("user-did");
    fakeAuthService.verifyOwnerToken.mockResolvedValue("owner-did");
    fakeSessionManager.updateRoomInfo.mockResolvedValue(undefined);
    fakeSessionManager.addClientToSession.mockResolvedValue(undefined);

    await handleAuth(deps, fakeIO, fakeSocket, fakeArgs, callback);

    const roomName = getRoomName(fakeArgs.documentId, fakeArgs.sessionDid);

    expect(fakeAuthService.verifyOwnerToken).toHaveBeenCalledWith(
      fakeArgs.ownerToken,
      fakeArgs.contractAddress,
      fakeArgs.ownerAddress
    );
    expect(fakeSessionManager.updateRoomInfo).toHaveBeenCalledWith(
      fakeArgs.documentId,
      existingSession.sessionDid,
      existingSession.ownerDid,
      fakeArgs.roomInfo
    );

    expect(fakeSocket.data.role).toBe("owner");
    expect(fakeSocket.join).toHaveBeenCalledWith(roomName);
    expect(fakeBroadcastOperator.emit).toHaveBeenCalledWith("/room/membership_change", {
      action: "user_joined",
      user: { role: "owner" },
      roomId: fakeArgs.documentId,
    });

    expect(callback).toHaveBeenCalledWith({
      status: true,
      statusCode: 200,
      data: {
        message: "Authentication successful",
        role: "owner",
        sessionType: "existing",
        roomInfo: existingSession.roomInfo,
      },
    });
  });

  it("returns 500 when an unexpected error occurs in auth handler", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket();
    const fakeArgs: AuthArgs = {
      documentId: "doc-1",
      sessionDid: "session-1",
      collaborationToken: "collab-token",
    };
    const callback = vi.fn();

    fakeSessionManager.getSession.mockRejectedValue(new Error("db error"));

    await handleAuth(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 500,
      error: "Internal server error",
      errorCode: ErrorCode.INTERNAL_ERROR,
    });
  });
});

