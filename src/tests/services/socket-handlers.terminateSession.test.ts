import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleTerminateSession } from "../../services/socket-handlers";
import type { AppServer, AppSocket } from "../../types";
import type { SocketHandlerDeps } from "../../services/socket-handlers.deps";

function createFakeIO(fetchSocketsResponse: any[] = []): AppServer {
  const fetchSocketsMock = vi.fn().mockResolvedValue(fetchSocketsResponse);

  return {
    in: vi.fn(() => ({
      fetchSockets: fetchSocketsMock,
    })),
  } as unknown as AppServer;
}

/**
 * Fake socket for handler tests.
 * If you pass a broadcastOperator, socket.to(room) will return it so you can assert
 * on broadcastOperator.emit(event, payload) in the test.
 */
function createFakeSocket(broadcastOperator?: { emit: ReturnType<typeof vi.fn> }) {
  const toReturn = broadcastOperator ?? { emit: vi.fn() };
  const socket = {
    id: "socket-1",
    data: {
      authenticated: true,
      documentId: "doc-1",
      sessionDid: "session-1",
      role: "owner" as const,
    },
    to: vi.fn(() => toReturn),
  } as unknown as AppSocket;
  return socket;
}

describe("handleTerminateSession", () => {
  const fakeAuthService = {
    verifyOwnerToken: vi.fn<[], Promise<string | null>>(),
  };
  const fakeSessionManager = {
    getSession: vi.fn(),
    deactivateSession: vi.fn(),
    terminateSession: vi.fn(),
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

  it("returns 400 when sessionDid is empty", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket();
    const fakeArgs = {
      documentId: "test-document-id",
      sessionDid: "",
      ownerToken: "test-owner-token",
      ownerAddress: "test-owner-address",
      contractAddress: "test-contract-address",
    };
    const callback = vi.fn();
    const callbackResponse = {
      status: false,
      statusCode: 400,
      error: "Session DID is required",
      errorCode: "SESSION_DID_MISSING",
    };
    await handleTerminateSession(deps, fakeIO, fakeSocket, fakeArgs, callback);
    expect(callback).toHaveBeenCalledWith(callbackResponse);
    expect(fakeSessionManager.getSession).not.toHaveBeenCalled();
  });

  it("returns 400 when contract or owner address format is invalid", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket();
    const fakeArgs = {
      documentId: "test-document-id",
      sessionDid: "test-session-did",
      ownerToken: "test-owner-token",
      ownerAddress: "not-a-valid-address",
      contractAddress: "0x0000000000000000000000000000000000000002",
    };
    const callback = vi.fn();

    const fakeSessionResponse = { ownerDid: "fake-owner-did", sessionDid: fakeArgs.sessionDid };
    fakeSessionManager.getSession.mockResolvedValue(fakeSessionResponse);

    await handleTerminateSession(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(fakeSessionManager.getSession).toHaveBeenCalledWith(
      fakeArgs.documentId,
      fakeArgs.sessionDid
    );
    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 400,
      error: "Invalid contract address or owner address format",
      errorCode: "INVALID_ADDRESS",
    });
    expect(fakeAuthService.verifyOwnerToken).not.toHaveBeenCalled();
  });

  it("returns 404 when session is not found", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket();
    const fakeArgs = {
      documentId: "test-document-id",
      sessionDid: "test-session-did",
      ownerToken: "test-owner-token",
      ownerAddress: "0x0000000000000000000000000000000000000001",
      contractAddress: "0x0000000000000000000000000000000000000002",
    };
    const callback = vi.fn();

    fakeSessionManager.getSession.mockResolvedValue(undefined);
    await handleTerminateSession(deps, fakeIO, fakeSocket, fakeArgs, callback);

    const callbackResponse = {
      status: false,
      statusCode: 404,
      error: "Session not found",
      errorCode: "SESSION_NOT_FOUND",
    };
    expect(fakeSessionManager.getSession).toHaveBeenCalledWith(
      fakeArgs.documentId,
      fakeArgs.sessionDid
    );
    expect(callback).toHaveBeenCalledWith(callbackResponse);
  });

  it("returns 401 when ownerDid does not match session owner", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket();
    const fakeArgs = {
      documentId: "test-document-id",
      sessionDid: "test-session-did",
      ownerToken: "test-owner-token",
      ownerAddress: "0x0000000000000000000000000000000000000001",
      contractAddress: "0x0000000000000000000000000000000000000002",
    };
    const callback = vi.fn();

    const fakeSessionResponse = { ownerDid: "fake-owner-did" };
    const ownerDidResponse = "different-owner-did";
    fakeSessionManager.getSession.mockResolvedValue(fakeSessionResponse);
    fakeAuthService.verifyOwnerToken.mockResolvedValue(ownerDidResponse);

    await handleTerminateSession(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(fakeSessionManager.getSession).toHaveBeenCalledWith(
      fakeArgs.documentId,
      fakeArgs.sessionDid
    );

    expect(fakeAuthService.verifyOwnerToken).toHaveBeenCalledWith(
      fakeArgs.ownerToken,
      fakeArgs.contractAddress,
      fakeArgs.ownerAddress,
    );

    const callbackResponse = {
      status: false,
      statusCode: 401,
      error: "Unauthorized",
      errorCode: "AUTH_TOKEN_INVALID",
    };
    expect(callback).toHaveBeenCalledWith(callbackResponse);
  });

  it("returns 200 when session is terminated", async () => {
    // Mock: io.in(roomName).fetchSockets() will resolve to this array
    const fetchSocketsResponse = [
      {
        id: "peer-1",
        data: { authenticated: true },
        leave: vi.fn(),
      },
    ];
    /**
     * To mock this
     * const sockets = await io.in(roomName).fetchSockets();
     * such that, the fetchSockets() returns a mock value that we set.
     */
    const fakeIO = createFakeIO(fetchSocketsResponse);

    /**
     * Likewise, we want to mock
     * socket.to(roomName).emit() calls
     * socket.to(roomName) returns a broadcast operator, which has an emit function on itself.
     * So, we want to mock all of that.
     */
    const fakeBroadcastOperator = { emit: vi.fn() };
    const fakeSocket = createFakeSocket(fakeBroadcastOperator);

    const fakeArgs = {
      documentId: "test-document-id",
      sessionDid: "test-session-did",
      ownerToken: "test-owner-token",
      ownerAddress: "0x0000000000000000000000000000000000000001",
      contractAddress: "0x0000000000000000000000000000000000000002",
    };
    const callback = vi.fn();

    const fakeSessionResponse = {
      sessionDid: fakeArgs.sessionDid,
      ownerDid: "match-owner-did",
    };
    const ownerDidResponse = "match-owner-did";

    // set the mock return values
    fakeSessionManager.getSession.mockResolvedValue(fakeSessionResponse);
    fakeAuthService.verifyOwnerToken.mockResolvedValue(ownerDidResponse);
    fakeSessionManager.terminateSession.mockResolvedValue(undefined);

    // now actually call the function
    await handleTerminateSession(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(fakeSessionManager.getSession).toHaveBeenCalledOnce();
    expect(fakeSessionManager.getSession).toHaveBeenCalledWith(
      fakeArgs.documentId,
      fakeArgs.sessionDid
    );

    expect(fakeAuthService.verifyOwnerToken).toHaveBeenCalledOnce();
    expect(fakeAuthService.verifyOwnerToken).toHaveBeenCalledWith(
      fakeArgs.ownerToken,
      fakeArgs.contractAddress,
      fakeArgs.ownerAddress,
    );

    const roomName = `session::${fakeArgs.documentId}__${fakeSessionResponse.sessionDid}`;

    expect(fakeSocket.to).toHaveBeenCalledWith(roomName);
    expect(fakeBroadcastOperator.emit).toHaveBeenCalledWith("/session/terminated", {
      roomId: fakeArgs.documentId,
    });

    expect(fetchSocketsResponse[0].leave).toHaveBeenCalledWith(roomName);
    expect(fetchSocketsResponse[0].data.authenticated).toBe(false);
    expect(fakeSessionManager.terminateSession).toHaveBeenCalledWith(
      fakeArgs.documentId,
      fakeSessionResponse.sessionDid
    );

    const callbackResponse = {
      status: true,
      statusCode: 200,
      data: { message: "Session terminated" },
    };
    expect(callback).toHaveBeenCalledWith(callbackResponse);
  });

  it("returns 500 when an unexpected error occurs in terminate session handler", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket();
    const fakeArgs = {
      documentId: "test-document-id",
      sessionDid: "test-session-did",
      ownerToken: "test-owner-token",
      ownerAddress: "0x0000000000000000000000000000000000000001",
      contractAddress: "0x0000000000000000000000000000000000000002",
    };
    const callback = vi.fn();

    fakeSessionManager.getSession.mockRejectedValue(new Error("db error"));

    await handleTerminateSession(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 500,
      error: "Internal server error",
      errorCode: "INTERNAL_ERROR",
    });
  });
});

