import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleAuth, getRoomName } from "./socket-handlers";
import type { AppServer, AppSocket, AuthArgs } from "../types";
import type { SocketHandlerDeps } from "./socket-handlers.deps";

function createFakeIO(): AppServer {
  return {
    in: vi.fn(),
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
    terminateOtherExistingSessions: vi.fn(),
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
      ownerAddress: "0xowner",
      contractAddress: "0xcontract",
      roomInfo: "room-info",
    };
    const callback = vi.fn();

    fakeSessionManager.getSession.mockResolvedValue(undefined);
    fakeAuthService.verifyOwnerToken.mockResolvedValue("owner-did");
    fakeSessionManager.terminateOtherExistingSessions.mockResolvedValue(undefined);
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
    expect(fakeSessionManager.terminateOtherExistingSessions).toHaveBeenCalledWith(
      fakeArgs.documentId,
      "owner-did"
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
    });
  });
});

