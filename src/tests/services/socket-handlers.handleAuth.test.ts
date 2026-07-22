import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleAuth, getRoomName } from "../../services/socket-handlers";
import { AppServer, AppSocket, AuthArgs, ErrorCode } from "../../types";
import type { SocketHandlerDeps } from "../../services/socket-handlers.deps";

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
    verifyIdentityToken: vi.fn(),
    verifyEditUcan: vi.fn(),
    getServerDid: vi.fn(),
  };
  const fakeSessionManager = {
    getSession: vi.fn(),
    getSessionIncludingTerminated: vi.fn(),
    getOtherNonTerminatedSessions: vi.fn(),
    terminateSession: vi.fn(),
    createSession: vi.fn(),
    updateRoomInfo: vi.fn(),
    addClientToSession: vi.fn(),
    removeClientFromSession: vi.fn(),
    getCollabJoinEnabled: vi.fn(),
    getWorkspaceEditEnabled: vi.fn(),
    fillOwnerIdentityDidIfAbsent: vi.fn(),
    updateSessionOwnerDid: vi.fn(),
  };
  const fakeMongoDBStore = {
    getDocumentMeta: vi.fn().mockResolvedValue(null),
    getMinEditEpoch: vi.fn().mockResolvedValue(0),
  } as any;

  const deps: SocketHandlerDeps = {
    authService: fakeAuthService as any,
    sessionManager: fakeSessionManager as any,
    mongodbStore: fakeMongoDBStore,
    editBoundCache: { check: vi.fn() } as any,
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
      identityToken: "identity-token",
      identityContractAddress: "0x0000000000000000000000000000000000000003",
      roomInfo: "room-info",
    };
    const callback = vi.fn();

    fakeSessionManager.getSession.mockResolvedValue(undefined);
    fakeAuthService.verifyOwnerToken.mockResolvedValue("owner-did");
    fakeAuthService.verifyIdentityToken.mockResolvedValue("owner-identity-did");
    fakeSessionManager.getOtherNonTerminatedSessions.mockResolvedValue([]);
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
    expect(fakeSessionManager.getOtherNonTerminatedSessions).toHaveBeenCalledWith(
      fakeArgs.documentId,
      "owner-did",
      fakeArgs.contractAddress,
      fakeArgs.sessionDid,
    );
    expect(fakeSessionManager.createSession).toHaveBeenCalledWith({
      documentId: fakeArgs.documentId,
      sessionDid: fakeArgs.sessionDid,
      ownerDid: "owner-did",
      ownerIdentityDid: "owner-identity-did",
      portalAddress: fakeArgs.contractAddress,
      collabJoinEnabled: false,
      roomInfo: fakeArgs.roomInfo,
      appType: "ddoc",
    });

    expect(fakeSocket.data.appType).toBe("ddoc");

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
        title: null,
      },
    });
  });

  it("returns the latest stored DocumentMeta title in the ack", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket();
    const fakeArgs: AuthArgs = {
      documentId: "doc-1",
      sessionDid: "session-1",
      collaborationToken: "collab-token",
      ownerToken: "owner-token",
      ownerAddress: "0x0000000000000000000000000000000000000001",
      contractAddress: "0x0000000000000000000000000000000000000002",
      identityToken: "identity-token",
      identityContractAddress: "0x0000000000000000000000000000000000000003",
      roomInfo: "room-info",
    };
    const callback = vi.fn();

    fakeSessionManager.getSession.mockResolvedValue(undefined);
    fakeAuthService.verifyOwnerToken.mockResolvedValue("owner-did");
    fakeAuthService.verifyIdentityToken.mockResolvedValue("owner-identity-did");
    fakeSessionManager.getOtherNonTerminatedSessions.mockResolvedValue([]);
    fakeMongoDBStore.getDocumentMeta.mockResolvedValueOnce({ editLock: null, title: "enc-title" });

    await handleAuth(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(fakeMongoDBStore.getDocumentMeta).toHaveBeenCalledWith("doc-1");
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 200,
        data: expect.objectContaining({ title: "enc-title" }),
      })
    );
  });

  it("returns a null ack title when the DocumentMeta read fails", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket();
    const fakeArgs: AuthArgs = {
      documentId: "doc-1",
      sessionDid: "session-1",
      collaborationToken: "collab-token",
      ownerToken: "owner-token",
      ownerAddress: "0x0000000000000000000000000000000000000001",
      contractAddress: "0x0000000000000000000000000000000000000002",
      identityToken: "identity-token",
      identityContractAddress: "0x0000000000000000000000000000000000000003",
      roomInfo: "room-info",
    };
    const callback = vi.fn();

    fakeSessionManager.getSession.mockResolvedValue(undefined);
    fakeAuthService.verifyOwnerToken.mockResolvedValue("owner-did");
    fakeAuthService.verifyIdentityToken.mockResolvedValue("owner-identity-did");
    fakeSessionManager.getOtherNonTerminatedSessions.mockResolvedValue([]);
    fakeMongoDBStore.getDocumentMeta.mockRejectedValueOnce(new Error("mongo down"));

    await handleAuth(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 200,
        data: expect.objectContaining({ title: null }),
      })
    );
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
      identityToken: "identity-token",
      identityContractAddress: "0x0000000000000000000000000000000000000003",
      roomInfo: "room-info",
    };
    const callback = vi.fn();

    const otherSessions = [
      { documentId: fakeArgs.documentId, sessionDid: "old-session-1", appType: "ddoc" as const },
      { documentId: fakeArgs.documentId, sessionDid: "old-session-2", appType: "ddoc" as const },
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
    fakeAuthService.verifyIdentityToken.mockResolvedValue("owner-identity-did");
    fakeSessionManager.getOtherNonTerminatedSessions.mockResolvedValue(otherSessions);
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
    expect(fakeSessionManager.getOtherNonTerminatedSessions).toHaveBeenCalledWith(
      fakeArgs.documentId,
      "owner-did",
      fakeArgs.contractAddress,
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
      otherSessions[0].sessionDid,
      "ddoc"
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
      otherSessions[1].sessionDid,
      "ddoc"
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
        title: null,
      },
    });
  });

  it("terminates other sessions using their OWN appType, not the new connection's claimed appType", async () => {
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
      // The new connection claims "dsheet" for this document...
      appType: "dsheet",
    };
    const callback = vi.fn();

    // ...but the session being terminated is actually a "ddoc" session.
    const otherSession = {
      documentId: fakeArgs.documentId,
      sessionDid: "old-session-1",
      appType: "ddoc" as const,
    };

    fakeSessionManager.getSession.mockResolvedValue(undefined);
    fakeAuthService.verifyOwnerToken.mockResolvedValue("owner-did");
    fakeAuthService.verifyIdentityToken.mockResolvedValue("owner-identity-did");
    fakeSessionManager.getOtherNonTerminatedSessions.mockResolvedValue([otherSession]);
    fakeSessionManager.terminateSession.mockResolvedValue(undefined);
    fakeSessionManager.createSession.mockResolvedValue(undefined);
    fakeSessionManager.addClientToSession.mockResolvedValue(undefined);

    await handleAuth(deps, fakeIO, fakeSocket, fakeArgs, callback);

    // terminateSession must use the terminated session's own appType ("ddoc"), never
    // the claimed appType of the new connection ("dsheet") — otherwise a dsheet
    // re-auth would cascade-delete a ddoc's durable rows.
    expect(fakeSessionManager.terminateSession).toHaveBeenCalledWith(
      otherSession.documentId,
      otherSession.sessionDid,
      "ddoc"
    );
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
    fakeSessionManager.getCollabJoinEnabled.mockResolvedValue(true);

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
        title: null,
      },
    });
  });

  it("rotationCutover: silently migrates room, skips user_joined, and cleans up the old session's client list", async () => {
    const fakeIO = createFakeIO();
    const fakeBroadcastOperator = { emit: vi.fn() };
    // Already-authed socket: socket.data.sessionDid holds the PRE-rotation sessionDid.
    const fakeSocket = createFakeSocket(fakeBroadcastOperator, {
      authenticated: true,
      documentId: "doc-1",
      sessionDid: "session-1-old",
      role: "editor",
    });
    (fakeSocket as any).leave = vi.fn();

    const fakeArgs: AuthArgs = {
      documentId: "doc-1",
      sessionDid: "session-1-new",
      collaborationToken: "collab-token",
      rotationCutover: true,
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
    fakeSessionManager.removeClientFromSession.mockResolvedValue(undefined);
    fakeSessionManager.getCollabJoinEnabled.mockResolvedValue(true);

    await handleAuth(deps, fakeIO, fakeSocket, fakeArgs, callback);

    const oldRoomName = getRoomName(fakeArgs.documentId, "session-1-old");
    const newRoomName = getRoomName(fakeArgs.documentId, fakeArgs.sessionDid);

    // Silent leave of the prior room — no /room/membership_change for it.
    expect((fakeSocket as any).leave).toHaveBeenCalledWith(oldRoomName);
    expect(fakeSessionManager.removeClientFromSession).toHaveBeenCalledWith(
      fakeArgs.documentId,
      "session-1-old",
      fakeSocket.id
    );

    // Normal admission into the new room is unaffected.
    expect(fakeSocket.join).toHaveBeenCalledWith(newRoomName);
    expect(fakeSessionManager.addClientToSession).toHaveBeenCalledWith(
      fakeArgs.documentId,
      fakeArgs.sessionDid,
      fakeSocket.id
    );
    expect(fakeSocket.data.sessionDid).toBe(fakeArgs.sessionDid);

    // No membership blip on the rotation cutover join.
    expect(fakeBroadcastOperator.emit).not.toHaveBeenCalledWith(
      "/room/membership_change",
      expect.objectContaining({ action: "user_joined" })
    );

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ status: true, statusCode: 200 })
    );
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

  it("returns 400 when in owner flow but owner token or session DID is missing", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket();
    const callback = vi.fn();

    fakeSessionManager.getSession.mockResolvedValue(undefined);

    let sessionDidReadCount = 0;
    const argsWithGetterSessionDid = {
      documentId: "doc-1",
      get sessionDid() {
        sessionDidReadCount++;
        return sessionDidReadCount === 1 ? "session-1" : (undefined as any);
      },
      collaborationToken: "collab-token",
      ownerToken: "owner-token",
      ownerAddress: "0x0000000000000000000000000000000000000001",
      contractAddress: "0x0000000000000000000000000000000000000002",
    } as AuthArgs;

    await handleAuth(deps, fakeIO, fakeSocket, argsWithGetterSessionDid, callback);

    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 400,
      error: "Document ID, owner token, and session DID are required",
      errorCode: ErrorCode.AUTH_TOKEN_MISSING,
    });
  });

  it("returns 400 when in owner flow with invalid contract or owner address format", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket();
    const fakeArgs: AuthArgs = {
      documentId: "doc-1",
      sessionDid: "session-1",
      collaborationToken: "collab-token",
      ownerToken: "owner-token",
      ownerAddress: "not-a-valid-address",
      contractAddress: "0x0000000000000000000000000000000000000002",
      roomInfo: "room-info",
    };
    const callback = vi.fn();

    fakeSessionManager.getSession.mockResolvedValue(undefined);

    await handleAuth(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 400,
      error: "Invalid contract address or owner address format",
      errorCode: ErrorCode.INVALID_ADDRESS,
    });
  });

  it("returns 400 when joining existing session with owner token but invalid contract or owner address", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket();
    const fakeArgs: AuthArgs = {
      documentId: "doc-1",
      sessionDid: "session-1",
      collaborationToken: "collab-token",
      ownerToken: "owner-token",
      ownerAddress: "invalid-hex",
      contractAddress: "0x0000000000000000000000000000000000000002",
      roomInfo: "room-info",
    };
    const callback = vi.fn();

    const existingSession = {
      sessionDid: fakeArgs.sessionDid,
      ownerDid: "owner-did",
      roomInfo: "existing-room-info",
    };

    fakeSessionManager.getSession.mockResolvedValue(existingSession);
    fakeAuthService.verifyCollaborationToken.mockResolvedValue("user-did");

    await handleAuth(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 400,
      error: "Invalid contract address or owner address format",
      errorCode: ErrorCode.INVALID_ADDRESS,
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
    fakeAuthService.verifyIdentityToken.mockResolvedValue("owner-identity-did");
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
        title: null,
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

  it("stores appType from auth args when creating a new owner session", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket({ emit: vi.fn() });
    const fakeArgs: AuthArgs = {
      documentId: "doc-1",
      sessionDid: "session-1",
      collaborationToken: "collab-token",
      ownerToken: "owner-token",
      ownerAddress: "0x0000000000000000000000000000000000000001",
      contractAddress: "0x0000000000000000000000000000000000000002",
      roomInfo: "room-info",
      appType: "dsheet",
    };
    const callback = vi.fn();

    fakeSessionManager.getSession.mockResolvedValue(undefined);
    fakeAuthService.verifyOwnerToken.mockResolvedValue("owner-did");
    fakeAuthService.verifyIdentityToken.mockResolvedValue("owner-identity-did");
    fakeSessionManager.getOtherNonTerminatedSessions.mockResolvedValue([]);
    fakeSessionManager.createSession.mockResolvedValue(undefined);
    fakeSessionManager.addClientToSession.mockResolvedValue(undefined);

    await handleAuth(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(fakeSessionManager.createSession).toHaveBeenCalledWith({
      documentId: fakeArgs.documentId,
      sessionDid: fakeArgs.sessionDid,
      ownerDid: "owner-did",
      ownerIdentityDid: undefined,
      portalAddress: fakeArgs.contractAddress,
      collabJoinEnabled: false,
      roomInfo: fakeArgs.roomInfo,
      appType: "dsheet",
    });
    expect(fakeSocket.data.appType).toBe("dsheet");
  });

  it("joins an existing dsheet session when client declares the matching appType", async () => {
    const fakeIO = createFakeIO();
    const fakeBroadcastOperator = { emit: vi.fn() };
    const fakeSocket = createFakeSocket(fakeBroadcastOperator);
    const fakeArgs: AuthArgs = {
      documentId: "doc-1",
      sessionDid: "session-1",
      collaborationToken: "collab-token",
      appType: "dsheet",
    };
    const callback = vi.fn();

    const existingSession = {
      sessionDid: fakeArgs.sessionDid,
      ownerDid: "owner-did",
      roomInfo: "existing-room-info",
      appType: "dsheet",
    };

    fakeSessionManager.getSession.mockResolvedValue(existingSession);
    fakeAuthService.verifyCollaborationToken.mockResolvedValue("user-did");
    fakeSessionManager.addClientToSession.mockResolvedValue(undefined);

    await handleAuth(deps, fakeIO, fakeSocket, fakeArgs, callback);

    const roomName = getRoomName(fakeArgs.documentId, fakeArgs.sessionDid);
    expect(fakeSocket.join).toHaveBeenCalledWith(roomName);
    expect(fakeSocket.data.appType).toBe("dsheet");
    expect(callback).toHaveBeenCalledWith({
      status: true,
      statusCode: 200,
      data: {
        message: "Authentication successful",
        role: "editor",
        sessionType: "existing",
        roomInfo: existingSession.roomInfo,
        title: null,
      },
    });
  });

  it("rejects with APP_MISMATCH when the client appType differs from the document's app", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket({ emit: vi.fn() });
    const fakeArgs: AuthArgs = {
      documentId: "doc-1",
      sessionDid: "session-1",
      collaborationToken: "collab-token",
      appType: "dsheet",
    };
    const callback = vi.fn();

    const existingSession = {
      sessionDid: fakeArgs.sessionDid,
      ownerDid: "owner-did",
      roomInfo: "existing-room-info",
      appType: "ddoc",
    };

    fakeSessionManager.getSession.mockResolvedValue(existingSession);
    fakeAuthService.verifyCollaborationToken.mockResolvedValue("user-did");

    await handleAuth(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 403,
      error: "App type mismatch for this document",
      errorCode: ErrorCode.APP_MISMATCH,
    });
    expect(fakeSocket.join).not.toHaveBeenCalled();
  });

  it("rejects with APP_MISMATCH when a non-declaring (ddoc) client joins a dsheet document", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket({ emit: vi.fn() });
    const fakeArgs: AuthArgs = {
      documentId: "doc-1",
      sessionDid: "session-1",
      collaborationToken: "collab-token",
      // no appType → treated as "ddoc"
    };
    const callback = vi.fn();

    const existingSession = {
      sessionDid: fakeArgs.sessionDid,
      ownerDid: "owner-did",
      roomInfo: "existing-room-info",
      appType: "dsheet",
    };

    fakeSessionManager.getSession.mockResolvedValue(existingSession);
    fakeAuthService.verifyCollaborationToken.mockResolvedValue("user-did");

    await handleAuth(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 403,
      error: "App type mismatch for this document",
      errorCode: ErrorCode.APP_MISMATCH,
    });
    expect(fakeSocket.join).not.toHaveBeenCalled();
  });

  it("treats a legacy session (no appType) as ddoc and admits a non-declaring client", async () => {
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
      // no appType (legacy row) → resolves to "ddoc"
    };

    fakeSessionManager.getSession.mockResolvedValue(existingSession);
    fakeAuthService.verifyCollaborationToken.mockResolvedValue("user-did");
    fakeSessionManager.addClientToSession.mockResolvedValue(undefined);
    fakeSessionManager.getCollabJoinEnabled.mockResolvedValue(true);

    await handleAuth(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(fakeSocket.data.appType).toBe("ddoc");
    expect(callback).toHaveBeenCalledWith({
      status: true,
      statusCode: 200,
      data: {
        message: "Authentication successful",
        role: "editor",
        sessionType: "existing",
        roomInfo: existingSession.roomInfo,
        title: null,
      },
    });
  });

  it("rejects a non-owner join when collabJoinEnabled is explicitly false", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket({ emit: vi.fn() });
    const fakeArgs: AuthArgs = { documentId: "doc-1", sessionDid: "session-1", collaborationToken: "collab-token" };
    const callback = vi.fn();
    fakeSessionManager.getSession.mockResolvedValue({ sessionDid: "session-1", ownerDid: "owner-did", roomInfo: "r" });
    fakeSessionManager.getCollabJoinEnabled.mockResolvedValue(false); // fresh Mongo read
    fakeAuthService.verifyCollaborationToken.mockResolvedValue("user-did");

    await handleAuth(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(callback).toHaveBeenCalledWith({ status: false, statusCode: 403, error: "Link sharing is disabled for this document", errorCode: ErrorCode.JOIN_DISABLED });
    expect(fakeSocket.join).not.toHaveBeenCalled();
    expect(fakeSessionManager.addClientToSession).not.toHaveBeenCalled();
  });

  it("admits a non-owner join when collabJoinEnabled is true", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket({ emit: vi.fn() });
    const fakeArgs: AuthArgs = { documentId: "doc-1", sessionDid: "session-1", collaborationToken: "collab-token" };
    const callback = vi.fn();
    fakeSessionManager.getSession.mockResolvedValue({ sessionDid: "session-1", ownerDid: "owner-did", roomInfo: "r" });
    fakeSessionManager.getCollabJoinEnabled.mockResolvedValue(true); // fresh Mongo read
    fakeAuthService.verifyCollaborationToken.mockResolvedValue("user-did");
    fakeSessionManager.addClientToSession.mockResolvedValue(undefined);

    await handleAuth(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(fakeSocket.join).toHaveBeenCalled();
  });

  // Invariant #3 — the gate must NOT fire for dsheet, even with collabJoinEnabled:false.
  it("admits a dsheet editor even when collabJoinEnabled is false (ddoc-only gate)", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket({ emit: vi.fn() });
    const fakeArgs: AuthArgs = { documentId: "doc-1", sessionDid: "session-1", collaborationToken: "collab-token", appType: "dsheet" };
    const callback = vi.fn();
    fakeSessionManager.getSession.mockResolvedValue({ sessionDid: "session-1", ownerDid: "owner-did", roomInfo: "r", appType: "dsheet", collabJoinEnabled: false });
    fakeAuthService.verifyCollaborationToken.mockResolvedValue("user-did");
    fakeSessionManager.addClientToSession.mockResolvedValue(undefined);

    await handleAuth(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(fakeSocket.join).toHaveBeenCalled();
  });

  it("rejects a new ddoc owner session when the identity proof is missing", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket({ emit: vi.fn() });
    const fakeArgs: AuthArgs = {
      documentId: "doc-1",
      sessionDid: "session-1",
      collaborationToken: "collab-token",
      ownerToken: "owner-token",
      ownerAddress: "0x0000000000000000000000000000000000000001",
      contractAddress: "0x0000000000000000000000000000000000000002",
      // no identityToken / identityContractAddress
    };
    const callback = vi.fn();

    fakeSessionManager.getSession.mockResolvedValue(undefined);
    fakeAuthService.verifyOwnerToken.mockResolvedValue("owner-did");

    await handleAuth(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(fakeAuthService.verifyIdentityToken).not.toHaveBeenCalled();
    expect(fakeSessionManager.createSession).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 401,
      error: "Valid identity proof required to create a durable session",
      errorCode: ErrorCode.AUTH_TOKEN_INVALID,
    });
  });

  it("rejects a new ddoc owner session when the identity proof is invalid", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket({ emit: vi.fn() });
    const fakeArgs: AuthArgs = {
      documentId: "doc-1",
      sessionDid: "session-1",
      collaborationToken: "collab-token",
      ownerToken: "owner-token",
      ownerAddress: "0x0000000000000000000000000000000000000001",
      contractAddress: "0x0000000000000000000000000000000000000002",
      identityToken: "bad-identity-token",
      identityContractAddress: "0x0000000000000000000000000000000000000003",
    };
    const callback = vi.fn();

    fakeSessionManager.getSession.mockResolvedValue(undefined);
    fakeAuthService.verifyOwnerToken.mockResolvedValue("owner-did");
    fakeAuthService.verifyIdentityToken.mockResolvedValue(null);

    await handleAuth(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(fakeAuthService.verifyIdentityToken).toHaveBeenCalledWith(
      "bad-identity-token",
      "0x0000000000000000000000000000000000000003",
      "doc-1"
    );
    expect(fakeSessionManager.createSession).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 401,
      error: "Valid identity proof required to create a durable session",
      errorCode: ErrorCode.AUTH_TOKEN_INVALID,
    });
  });

  it("fills an absent ownerIdentityDid on an existing ddoc session for a proven owner", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket({ emit: vi.fn() });
    const fakeArgs: AuthArgs = {
      documentId: "doc-1",
      sessionDid: "session-1",
      collaborationToken: "collab-token",
      ownerToken: "owner-token",
      ownerAddress: "0x0000000000000000000000000000000000000001",
      contractAddress: "0x0000000000000000000000000000000000000002",
      identityToken: "identity-token",
      identityContractAddress: "0x0000000000000000000000000000000000000003",
    };
    const callback = vi.fn();

    const existingSession = {
      sessionDid: fakeArgs.sessionDid,
      ownerDid: "owner-did",
      roomInfo: "existing-room-info",
      appType: "ddoc",
      // no ownerIdentityDid (pre-fix / empty bind)
    };

    fakeSessionManager.getSession.mockResolvedValue(existingSession);
    fakeAuthService.verifyCollaborationToken.mockResolvedValue("user-did");
    fakeAuthService.verifyOwnerToken.mockResolvedValue("owner-did");
    fakeAuthService.verifyIdentityToken.mockResolvedValue("proven-identity-did");
    fakeSessionManager.fillOwnerIdentityDidIfAbsent.mockResolvedValue(undefined);
    fakeSessionManager.addClientToSession.mockResolvedValue(undefined);

    await handleAuth(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(fakeAuthService.verifyIdentityToken).toHaveBeenCalledWith(
      "identity-token",
      "0x0000000000000000000000000000000000000003",
      "doc-1"
    );
    expect(fakeSessionManager.fillOwnerIdentityDidIfAbsent).toHaveBeenCalledWith(
      "doc-1",
      "session-1",
      "proven-identity-did"
    );
    expect(fakeSocket.data.role).toBe("owner");
  });

  it("joinOnly: rejects ROOM_NOT_ESTABLISHED for a session that never existed, even after the terminated-inclusive retry", async () => {
    fakeSessionManager.getSession.mockResolvedValue(null);
    fakeSessionManager.getSessionIncludingTerminated.mockResolvedValue(undefined);
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket();
    const callback = vi.fn();

    await handleAuth(deps, fakeIO, fakeSocket, {
      documentId: "doc-1",
      sessionDid: "session-1",
      collaborationToken: "collab-token",
      ownerToken: "shared-workspace-owner-token",
      ownerAddress: "0x1111111111111111111111111111111111111111",
      contractAddress: "0x2222222222222222222222222222222222222222",
      joinOnly: true,
    }, callback);

    expect(fakeSessionManager.getSessionIncludingTerminated).toHaveBeenCalledWith("doc-1", "session-1");
    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 404,
      error: "Room not established",
      errorCode: ErrorCode.ROOM_NOT_ESTABLISHED,
    });
    expect(fakeSessionManager.createSession).not.toHaveBeenCalled();
  });

  describe("owner-verified joinOnly read admission", () => {
    const privateSession = {
      documentId: "doc-1",
      sessionDid: "session-1",
      ownerDid: "did:key:shared-portal",
      ownerIdentityDid: "did:key:creator",
      appType: "ddoc",
    };
    const verifiedOwnerJoinArgs = {
      documentId: "doc-1",
      sessionDid: "session-1",
      collaborationToken: "collab-token",
      ownerToken: "owner-token",
      ownerAddress: "0x1111111111111111111111111111111111111111",
      contractAddress: "0x2222222222222222222222222222222222222222",
      identityToken: "identity-token",
      identityContractAddress: "0x3333333333333333333333333333333333333333",
      joinOnly: true,
    };

    it("1. admits a verified owner into an EXISTING private session with no gp/workspace/public grants", async () => {
      fakeSessionManager.getSession.mockResolvedValue({ ...privateSession });
      fakeAuthService.verifyCollaborationToken.mockResolvedValue("did:key:collab");
      fakeAuthService.verifyOwnerToken.mockResolvedValue("did:key:shared-portal");
      fakeAuthService.verifyIdentityToken.mockResolvedValue("did:key:creator");
      fakeSessionManager.getWorkspaceEditEnabled.mockResolvedValue(undefined);
      fakeSessionManager.getCollabJoinEnabled.mockResolvedValue(undefined);
      const fakeSocket = createFakeSocket();
      const callback = vi.fn();

      await handleAuth(deps, createFakeIO(), fakeSocket, { ...verifiedOwnerJoinArgs }, callback);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          status: true,
          data: expect.objectContaining({ role: "editor" }),
        })
      );
      // Bypass is admission-only: no gp/workspace/public grant was computed for this socket.
      expect(fakeSocket.data.rail).toBeUndefined();
      expect(fakeSocket.data.railKind).toBeUndefined();
    });

    it("2. admits a verified owner into a TERMINATED session via the terminated-inclusive lookup", async () => {
      fakeSessionManager.getSession.mockResolvedValue(undefined);
      fakeSessionManager.getSessionIncludingTerminated.mockResolvedValue({ ...privateSession });
      fakeAuthService.verifyCollaborationToken.mockResolvedValue("did:key:collab");
      fakeAuthService.verifyOwnerToken.mockResolvedValue("did:key:shared-portal");
      fakeAuthService.verifyIdentityToken.mockResolvedValue("did:key:creator");
      fakeSessionManager.getWorkspaceEditEnabled.mockResolvedValue(undefined);
      fakeSessionManager.getCollabJoinEnabled.mockResolvedValue(undefined);
      const callback = vi.fn();

      await handleAuth(deps, createFakeIO(), createFakeSocket(), { ...verifiedOwnerJoinArgs }, callback);

      expect(fakeSessionManager.getSessionIncludingTerminated).toHaveBeenCalledWith("doc-1", "session-1");
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          status: true,
          data: expect.objectContaining({ role: "editor" }),
        })
      );
    });

    it("3. still rejects a NON-owner (no grants) with JOIN_DISABLED — the gate still applies", async () => {
      fakeSessionManager.getSession.mockResolvedValue({ ...privateSession });
      fakeAuthService.verifyCollaborationToken.mockResolvedValue("did:key:collab");
      // No ownerToken presented: ownerDid never resolves, so role resolves to "editor"
      // pre-cap too — this bearer was never owner-shaped in the first place.
      fakeSessionManager.getWorkspaceEditEnabled.mockResolvedValue(undefined);
      fakeSessionManager.getCollabJoinEnabled.mockResolvedValue(undefined);
      const callback = vi.fn();

      await handleAuth(
        deps,
        createFakeIO(),
        createFakeSocket(),
        {
          documentId: "doc-1",
          sessionDid: "session-1",
          collaborationToken: "collab-token",
          joinOnly: true,
        },
        callback
      );

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ status: false, statusCode: 403, errorCode: ErrorCode.JOIN_DISABLED })
      );
    });
  });

  it("joinOnly: caps role at editor and skips the null-fill heal on an unbound session", async () => {
    fakeSessionManager.getSession.mockResolvedValue({
      documentId: "doc-1",
      sessionDid: "session-1",
      ownerDid: "did:key:shared-portal",
      ownerIdentityDid: null,
      appType: "ddoc",
    });
    fakeAuthService.verifyCollaborationToken.mockResolvedValue("did:key:collab");
    fakeAuthService.verifyOwnerToken.mockResolvedValue("did:key:shared-portal");
    fakeAuthService.verifyIdentityToken.mockResolvedValue("did:key:member");
    fakeSessionManager.getWorkspaceEditEnabled.mockResolvedValue(true);
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket();
    const callback = vi.fn();

    await handleAuth(deps, fakeIO, fakeSocket, {
      documentId: "doc-1",
      sessionDid: "session-1",
      collaborationToken: "collab-token",
      ownerToken: "shared-workspace-owner-token",
      ownerAddress: "0x1111111111111111111111111111111111111111",
      contractAddress: "0x2222222222222222222222222222222222222222",
      identityToken: "member-identity-token",
      identityContractAddress: "0x3333333333333333333333333333333333333333",
      joinOnly: true,
    }, callback);

    expect(fakeSessionManager.fillOwnerIdentityDidIfAbsent).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        status: true,
        data: expect.objectContaining({ role: "editor" }),
      })
    );
    // This bearer resolved to "owner" pre-cap too (unbound session, shared-DID compare) —
    // the same ambiguous match already gets full owner rights via the plain (non-joinOnly)
    // path, so the rail gate is bypassed here rather than consulted.
    expect(fakeSocket.data.rail).toBeUndefined();
    expect(fakeSessionManager.getWorkspaceEditEnabled).not.toHaveBeenCalled();
  });

  const boundSession = {
    documentId: "doc-1",
    sessionDid: "session-1",
    ownerDid: "did:key:shared-portal",
    ownerIdentityDid: "did:key:creator",
    appType: "ddoc",
  };
  const boundJoinArgs = {
    documentId: "doc-1",
    sessionDid: "session-1",
    collaborationToken: "collab-token",
    ownerToken: "shared-workspace-owner-token",
    ownerAddress: "0x1111111111111111111111111111111111111111",
    contractAddress: "0x2222222222222222222222222222222222222222",
    identityToken: "identity-token",
    identityContractAddress: "0x3333333333333333333333333333333333333333",
  };

  it("role: proven identity == bound + matching ownerToken → owner", async () => {
    fakeSessionManager.getSession.mockResolvedValue({ ...boundSession });
    fakeAuthService.verifyCollaborationToken.mockResolvedValue("did:key:collab");
    fakeAuthService.verifyOwnerToken.mockResolvedValue("did:key:shared-portal");
    fakeAuthService.verifyIdentityToken.mockResolvedValue("did:key:creator");
    const callback = vi.fn();

    await handleAuth(deps, createFakeIO(), createFakeSocket(), { ...boundJoinArgs }, callback);

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ status: true, data: expect.objectContaining({ role: "owner" }) })
    );
  });

  it("role: proven identity differs from bound → editor (workspace member)", async () => {
    fakeSessionManager.getSession.mockResolvedValue({ ...boundSession });
    fakeAuthService.verifyCollaborationToken.mockResolvedValue("did:key:collab");
    fakeAuthService.verifyOwnerToken.mockResolvedValue("did:key:shared-portal");
    fakeAuthService.verifyIdentityToken.mockResolvedValue("did:key:member");
    fakeSessionManager.getWorkspaceEditEnabled.mockResolvedValue(true);
    const fakeSocket = createFakeSocket();
    const callback = vi.fn();

    await handleAuth(deps, createFakeIO(), fakeSocket, { ...boundJoinArgs }, callback);

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ status: true, data: expect.objectContaining({ role: "editor" }) })
    );
  });

  it("role: INVALID identity token on a bound session → 401, never a fallback", async () => {
    fakeSessionManager.getSession.mockResolvedValue({ ...boundSession });
    fakeAuthService.verifyCollaborationToken.mockResolvedValue("did:key:collab");
    fakeAuthService.verifyOwnerToken.mockResolvedValue("did:key:shared-portal");
    fakeAuthService.verifyIdentityToken.mockResolvedValue(null);
    const callback = vi.fn();

    await handleAuth(deps, createFakeIO(), createFakeSocket(), { ...boundJoinArgs }, callback);

    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 401,
      error: "Invalid identity proof",
      errorCode: ErrorCode.AUTH_TOKEN_INVALID,
    });
  });

  it("role: token-less join on a bound session → editor (owner needs a proven identity token)", async () => {
    fakeSessionManager.getSession.mockResolvedValue({ ...boundSession });
    fakeAuthService.verifyCollaborationToken.mockResolvedValue("did:key:collab");
    fakeAuthService.verifyOwnerToken.mockResolvedValue("did:key:shared-portal");
    fakeSessionManager.getWorkspaceEditEnabled.mockResolvedValue(true);
    const { identityToken, identityContractAddress, ...tokenless } = boundJoinArgs;
    const callback = vi.fn();

    await handleAuth(deps, createFakeIO(), createFakeSocket(), tokenless as any, callback);

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ status: true, data: expect.objectContaining({ role: "editor" }) })
    );
  });

  it("workspace arm: rejects a FOREIGN portal's valid ownerToken (no cross-portal admission)", async () => {
    fakeSessionManager.getSession.mockResolvedValue({ ...boundSession });
    fakeAuthService.verifyCollaborationToken.mockResolvedValue("did:key:collab");
    fakeAuthService.verifyOwnerToken.mockResolvedValue("did:key:OTHER-portal");
    fakeAuthService.verifyIdentityToken.mockResolvedValue("did:key:stranger");
    fakeSessionManager.getWorkspaceEditEnabled.mockResolvedValue(true);
    fakeSessionManager.getCollabJoinEnabled.mockResolvedValue(undefined);
    const callback = vi.fn();

    await handleAuth(deps, createFakeIO(), createFakeSocket(), { ...boundJoinArgs }, callback);

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403, errorCode: ErrorCode.JOIN_DISABLED })
    );
  });

  it("workspace arm: member is rejected fail-closed when the flag is undefined", async () => {
    fakeSessionManager.getSession.mockResolvedValue({ ...boundSession });
    fakeAuthService.verifyCollaborationToken.mockResolvedValue("did:key:collab");
    fakeAuthService.verifyOwnerToken.mockResolvedValue("did:key:shared-portal");
    fakeAuthService.verifyIdentityToken.mockResolvedValue("did:key:member");
    fakeSessionManager.getWorkspaceEditEnabled.mockResolvedValue(undefined);
    fakeSessionManager.getCollabJoinEnabled.mockResolvedValue(undefined);
    const callback = vi.fn();

    await handleAuth(deps, createFakeIO(), createFakeSocket(), { ...boundJoinArgs }, callback);

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403, errorCode: ErrorCode.JOIN_DISABLED })
    );
  });

  it("workspace arm: member with matching ownerDid + flag true → rail and railKind workspace", async () => {
    fakeSessionManager.getSession.mockResolvedValue({ ...boundSession });
    fakeAuthService.verifyCollaborationToken.mockResolvedValue("did:key:collab");
    fakeAuthService.verifyOwnerToken.mockResolvedValue("did:key:shared-portal");
    fakeAuthService.verifyIdentityToken.mockResolvedValue("did:key:member");
    fakeSessionManager.getWorkspaceEditEnabled.mockResolvedValue(true);
    const fakeSocket = createFakeSocket();
    const callback = vi.fn();

    await handleAuth(deps, createFakeIO(), fakeSocket, { ...boundJoinArgs }, callback);

    expect(fakeSocket.data.rail).toBe("workspace");
    expect(fakeSocket.data.railKind).toBe("workspace");
  });

  describe("rotation heal", () => {
    const rotatedSession = {
      documentId: "doc-1",
      sessionDid: "session-1",
      ownerDid: "did:key:old",
      ownerIdentityDid: "did:key:creator",
      portalAddress: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
      appType: "ddoc",
    };
    const rotatedJoinArgs = {
      documentId: "doc-1",
      sessionDid: "session-1",
      collaborationToken: "collab-token",
      ownerToken: "shared-workspace-owner-token",
      ownerAddress: "0x1111111111111111111111111111111111111111",
      // Same portal as rotatedSession.portalAddress, different case.
      contractAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      joinOnly: true,
    };

    it("adopts a rotated ownerDid for the session's own portal and admits the workspace member", async () => {
      fakeSessionManager.getSession.mockResolvedValue({ ...rotatedSession });
      fakeAuthService.verifyCollaborationToken.mockResolvedValue("did:key:collab");
      fakeAuthService.verifyOwnerToken.mockResolvedValue("did:key:new");
      fakeSessionManager.getWorkspaceEditEnabled.mockResolvedValue(true);
      const fakeSocket = createFakeSocket();
      const callback = vi.fn();

      await handleAuth(deps, createFakeIO(), fakeSocket, { ...rotatedJoinArgs }, callback);

      expect(fakeSessionManager.updateSessionOwnerDid).toHaveBeenCalledWith(
        "doc-1",
        "session-1",
        "did:key:new"
      );
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({ status: true }));
      // Post-heal, ownerDid matches. A token-less join on a bound session is capped to
      // "editor" (no legacy shared-DID owner), so the workspace member is admitted via the
      // workspace rail (tier = edit) rather than the owner-shaped joinOnly bypass.
      expect(fakeSocket.data.rail).toBe("workspace");
    });

    it("does NOT heal when the presented contractAddress differs from session.portalAddress", async () => {
      fakeSessionManager.getSession.mockResolvedValue({ ...rotatedSession });
      fakeAuthService.verifyCollaborationToken.mockResolvedValue("did:key:collab");
      fakeAuthService.verifyOwnerToken.mockResolvedValue("did:key:new");
      fakeSessionManager.getCollabJoinEnabled.mockResolvedValue(undefined);
      const callback = vi.fn();

      await handleAuth(
        deps,
        createFakeIO(),
        createFakeSocket(),
        {
          ...rotatedJoinArgs,
          contractAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
        callback
      );

      expect(fakeSessionManager.updateSessionOwnerDid).not.toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 403, errorCode: ErrorCode.JOIN_DISABLED })
      );
    });

    it("does NOT heal when portalAddress is null (legacy session)", async () => {
      fakeSessionManager.getSession.mockResolvedValue({ ...rotatedSession, portalAddress: null });
      fakeAuthService.verifyCollaborationToken.mockResolvedValue("did:key:collab");
      fakeAuthService.verifyOwnerToken.mockResolvedValue("did:key:new");
      fakeSessionManager.getCollabJoinEnabled.mockResolvedValue(undefined);
      const callback = vi.fn();

      await handleAuth(deps, createFakeIO(), createFakeSocket(), { ...rotatedJoinArgs }, callback);

      expect(fakeSessionManager.updateSessionOwnerDid).not.toHaveBeenCalled();
    });

    it("restores owner role for the identity-bound creator after rotation", async () => {
      fakeSessionManager.getSession.mockResolvedValue({ ...rotatedSession });
      fakeAuthService.verifyCollaborationToken.mockResolvedValue("did:key:collab");
      fakeAuthService.verifyOwnerToken.mockResolvedValue("did:key:new");
      fakeAuthService.verifyIdentityToken.mockResolvedValue("did:key:creator");
      const callback = vi.fn();

      await handleAuth(
        deps,
        createFakeIO(),
        createFakeSocket(),
        {
          ...rotatedJoinArgs,
          joinOnly: false,
          identityToken: "identity-token",
          identityContractAddress: "0x3333333333333333333333333333333333333333",
        },
        callback
      );

      expect(fakeSessionManager.updateSessionOwnerDid).toHaveBeenCalledWith(
        "doc-1",
        "session-1",
        "did:key:new"
      );
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ status: true, data: expect.objectContaining({ role: "owner" }) })
      );
    });
  });

  describe("actorIdentityDid stamp", () => {
    it("stamps the proven identity DID on the socket for a member join", async () => {
      fakeSessionManager.getSession.mockResolvedValue({ ...boundSession });
      fakeAuthService.verifyCollaborationToken.mockResolvedValue("did:key:collab");
      fakeAuthService.verifyOwnerToken.mockResolvedValue("did:key:shared-portal");
      fakeAuthService.verifyIdentityToken.mockResolvedValue("did:key:member");
      fakeSessionManager.getWorkspaceEditEnabled.mockResolvedValue(true);
      const fakeSocket = createFakeSocket();
      const callback = vi.fn();

      await handleAuth(deps, createFakeIO(), fakeSocket, { ...boundJoinArgs }, callback);

      expect(fakeSocket.data.actorIdentityDid).toBe("did:key:member");
    });

    it("leaves actorIdentityDid undefined when no identityToken is presented", async () => {
      fakeSessionManager.getSession.mockResolvedValue({ ...boundSession });
      fakeAuthService.verifyCollaborationToken.mockResolvedValue("did:key:collab");
      fakeAuthService.verifyOwnerToken.mockResolvedValue("did:key:shared-portal");
      const { identityToken, identityContractAddress, ...tokenless } = boundJoinArgs;
      const fakeSocket = createFakeSocket();
      const callback = vi.fn();

      await handleAuth(deps, createFakeIO(), fakeSocket, tokenless as any, callback);

      expect(fakeSocket.data.actorIdentityDid).toBeUndefined();
    });
  });
});

describe("handleAuth — edit-claim admission (existing session, non-owner)", () => {
  const fakeAuthService = {
    verifyOwnerToken: vi.fn(),
    verifyCollaborationToken: vi.fn(),
    verifyIdentityToken: vi.fn(),
    verifyEditUcan: vi.fn(),
    getServerDid: vi.fn(),
  };
  const fakeSessionManager = {
    getSession: vi.fn(),
    getOtherNonTerminatedSessions: vi.fn(),
    terminateSession: vi.fn(),
    createSession: vi.fn(),
    updateRoomInfo: vi.fn(),
    addClientToSession: vi.fn(),
    getCollabJoinEnabled: vi.fn(),
    getWorkspaceEditEnabled: vi.fn(),
    fillOwnerIdentityDidIfAbsent: vi.fn(),
  };
  const fakeMongoDBStore = {
    getDocumentMeta: vi.fn().mockResolvedValue(null),
    getMinEditEpoch: vi.fn().mockResolvedValue(0),
  } as any;

  const deps: SocketHandlerDeps = {
    authService: fakeAuthService as any,
    sessionManager: fakeSessionManager as any,
    mongodbStore: fakeMongoDBStore,
    editBoundCache: { check: vi.fn() } as any,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseArgs = (over: Partial<AuthArgs> = {}): AuthArgs => ({
    documentId: "doc-1",
    sessionDid: "sess-1",
    collaborationToken: "ct",
    appType: "ddoc",
    ...over,
  });

  function existingSessionSetup() {
    fakeSessionManager.getSession.mockResolvedValue({
      sessionDid: "sess-1",
      ownerDid: "owner-did",
      appType: "ddoc",
    });
    fakeAuthService.verifyCollaborationToken.mockResolvedValue("user-did");
    fakeSessionManager.addClientToSession.mockResolvedValue(true);
  }

  it("rejects an editUcan that verifies to null (epoch-fact UCANs retired)", async () => {
    existingSessionSetup();
    fakeAuthService.verifyEditUcan.mockResolvedValue(null);
    const socket = createFakeSocket();
    const cb = vi.fn();
    await handleAuth(deps, createFakeIO(), socket, baseArgs({ editUcan: "epoch-fact" }), cb);
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({ status: false, statusCode: 403, errorCode: ErrorCode.JOIN_DISABLED })
    );
  });

  it("REJECTS an invalid editUcan (verifyEditUcan → null) without falling through", async () => {
    existingSessionSetup();
    fakeAuthService.verifyEditUcan.mockResolvedValue(null);
    fakeSessionManager.getCollabJoinEnabled.mockResolvedValue(true);
    const socket = createFakeSocket();
    const cb = vi.fn();
    await handleAuth(deps, createFakeIO(), socket, baseArgs({ editUcan: "forged" }), cb);
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ status: false, errorCode: ErrorCode.JOIN_DISABLED }));
    expect(socket.data.rail).toBeUndefined();
  });

  it("admits a workspace editor (member proof + tier enabled) with rail=workspace", async () => {
    // The shared portal secret (ownerToken) only proves portal membership; the per-person
    // identity proof decides owner-vs-editor. Here identity resolves a non-creator DID, so
    // this bearer is a workspace editor even though ownerToken matches the session's own ownerDid.
    fakeSessionManager.getSession.mockResolvedValue({
      sessionDid: "sess-1",
      ownerDid: "owner-did",
      ownerIdentityDid: "owner-identity-did",
      appType: "ddoc",
    });
    fakeAuthService.verifyCollaborationToken.mockResolvedValue("user-did");
    fakeSessionManager.addClientToSession.mockResolvedValue(true);
    fakeAuthService.verifyOwnerToken.mockResolvedValue("owner-did"); // session's own ownerDid
    fakeAuthService.verifyIdentityToken.mockResolvedValue("member-identity-did"); // != bound owner identity ⇒ editor
    fakeSessionManager.getWorkspaceEditEnabled.mockResolvedValue(true);
    const socket = createFakeSocket();
    const cb = vi.fn();
    await handleAuth(
      deps,
      createFakeIO(),
      socket,
      baseArgs({
        ownerToken: "ot",
        ownerAddress: "0x1111111111111111111111111111111111111111",
        contractAddress: "0x2222222222222222222222222222222222222222",
        identityToken: "it",
        identityContractAddress: "0x3333333333333333333333333333333333333333",
      }),
      cb
    );
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ status: true }));
    expect(socket.data.rail).toBe("workspace");
    expect(socket.data.railKind).toBe("workspace");
  });

  describe("epoch floor (minEditEpoch)", () => {
    it("rejects a gp-actor editUcan whose epoch is below the doc's minEditEpoch floor", async () => {
      existingSessionSetup();
      fakeAuthService.verifyEditUcan.mockResolvedValue({ kind: "actor", editHandle: "h1", epoch: 1 });
      fakeMongoDBStore.getMinEditEpoch.mockResolvedValue(2);
      const socket = createFakeSocket();
      const cb = vi.fn();
      await handleAuth(deps, createFakeIO(), socket, baseArgs({ editUcan: "gp-token" }), cb);
      expect(fakeMongoDBStore.getMinEditEpoch).toHaveBeenCalledWith("doc-1");
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ status: false, statusCode: 403, errorCode: ErrorCode.JOIN_DISABLED })
      );
      expect(deps.editBoundCache.check).not.toHaveBeenCalled();
      expect(socket.data.rail).toBeUndefined();
    });

    it("admits a gp-actor editUcan whose epoch meets the doc's minEditEpoch floor", async () => {
      existingSessionSetup();
      fakeAuthService.verifyEditUcan.mockResolvedValue({ kind: "actor", editHandle: "h1", epoch: 2 });
      fakeMongoDBStore.getMinEditEpoch.mockResolvedValue(2);
      (deps.editBoundCache.check as ReturnType<typeof vi.fn>).mockResolvedValue("bound");
      const socket = createFakeSocket();
      const cb = vi.fn();
      await handleAuth(deps, createFakeIO(), socket, baseArgs({ editUcan: "gp-token" }), cb);
      expect(cb).toHaveBeenCalledWith(expect.objectContaining({ status: true }));
      expect(socket.data.rail).toBe("gp");
      expect(socket.data.railKind).toBe("gp-actor");
      expect(socket.data.actorHandle).toBe("h1");
    });
  });

  it("public bearer is admitted as rail=public ONLY on collabJoinEnabled === true", async () => {
    existingSessionSetup();
    fakeSessionManager.getCollabJoinEnabled.mockResolvedValue(true);
    const socket = createFakeSocket();
    const cb = vi.fn();
    await handleAuth(deps, createFakeIO(), socket, baseArgs(), cb);
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ status: true }));
    expect(socket.data.rail).toBe("public");
  });

  it("REJECTS a public bearer when collabJoinEnabled === undefined (legacy hardening — was open)", async () => {
    existingSessionSetup();
    fakeSessionManager.getCollabJoinEnabled.mockResolvedValue(undefined);
    const socket = createFakeSocket();
    const cb = vi.fn();
    await handleAuth(deps, createFakeIO(), socket, baseArgs(), cb);
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ status: false, errorCode: ErrorCode.JOIN_DISABLED }));
    expect(socket.data.rail).toBeUndefined();
  });
});

