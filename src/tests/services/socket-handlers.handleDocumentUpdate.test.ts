import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleDocumentUpdate, getRoomName } from "../../services/socket-handlers";
import type { AppServer, AppSocket, DocumentUpdateArgs } from "../../types";
import type { SocketHandlerDeps } from "../../services/socket-handlers.deps";
import { ErrorCode } from "../../types";

function createFakeIO(): AppServer {
  return {} as unknown as AppServer;
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
    authenticated: true,
    documentId: "test-document-id",
    sessionDid: "test-session-did",
    role: "owner" as const,
  };
  const data = { ...defaultData, ...dataOverrides };

  return {
    id: "socket-1",
    data,
    to: vi.fn(() => toReturn),
  } as unknown as AppSocket;
}

describe("handleDocumentUpdate", () => {
  const fakeAuthService = {
    verifyCollaborationToken: vi.fn(),
  };
  const fakeSessionManager = {
    getRuntimeSession: vi.fn(),
    getWorkspaceEditEnabled: vi.fn(),
    getCollabJoinEnabled: vi.fn(),
  };
  const fakeMongoDBStore = {
    createUpdate: vi.fn(),
  };

  const deps: SocketHandlerDeps = {
    authService: fakeAuthService as any,
    sessionManager: fakeSessionManager as any,
    mongodbStore: fakeMongoDBStore as any,
    gateEpochCache: { getEditGrantEpoch: vi.fn() } as any,
    editBoundCache: {} as any,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when socket is not authenticated", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket(undefined, { authenticated: false });
    const fakeArgs: DocumentUpdateArgs = {
      documentId: "doc-1",
      data: "update-data",
      collaborationToken: "token",
    };
    const callback = vi.fn();

    await handleDocumentUpdate(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 401,
      error: "Not authenticated or session not found",
      errorCode: ErrorCode.NOT_AUTHENTICATED,
    });
  });

  it("returns 400 when data is missing", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket();
    const fakeArgs: DocumentUpdateArgs = {
      documentId: "doc-1",
      data: "" as any,
      collaborationToken: "token",
    };
    const callback = vi.fn();

    await handleDocumentUpdate(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 400,
      error: "Update data is required",
      errorCode: ErrorCode.UPDATE_DATA_MISSING,
    });
  });

  it("returns 404 when runtime session is not found", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket();
    const fakeArgs: DocumentUpdateArgs = {
      documentId: "doc-1",
      data: "update-data",
      collaborationToken: "token",
    };
    const callback = vi.fn();

    fakeSessionManager.getRuntimeSession.mockResolvedValue(undefined);

    await handleDocumentUpdate(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(fakeSessionManager.getRuntimeSession).toHaveBeenCalledWith(
      fakeArgs.documentId,
      fakeSocket.data.sessionDid
    );
    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 404,
      error: "Session not found",
      errorCode: ErrorCode.SESSION_NOT_FOUND,
    });
  });

  it("returns 401 when collaboration token verification fails", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket();
    const fakeArgs: DocumentUpdateArgs = {
      documentId: "doc-1",
      data: "update-data",
      collaborationToken: "token",
    };
    const callback = vi.fn();

    const runtimeSession = { sessionDid: fakeSocket.data.sessionDid };
    fakeSessionManager.getRuntimeSession.mockResolvedValue(runtimeSession);
    fakeAuthService.verifyCollaborationToken.mockResolvedValue(false);

    await handleDocumentUpdate(deps, fakeIO, fakeSocket, fakeArgs, callback);
    expect(fakeSessionManager.getRuntimeSession).toHaveBeenCalledWith(
      fakeArgs.documentId,
      fakeSocket.data.sessionDid,
    );
    expect(fakeAuthService.verifyCollaborationToken).toHaveBeenCalledWith(
      fakeArgs.collaborationToken,
      runtimeSession.sessionDid,
      fakeArgs.documentId
    );
    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 401,
      error: "Authentication failed",
      errorCode: ErrorCode.AUTH_TOKEN_INVALID,
    });
  });

  it("creates update and broadcasts when all checks pass", async () => {
    const fakeIO = createFakeIO();
    const fakeBroadcastOperator = { emit: vi.fn() };
    const fakeSocket = createFakeSocket(fakeBroadcastOperator);
    const fakeArgs: DocumentUpdateArgs = {
      documentId: "doc-1",
      data: "update-data",
      collaborationToken: "token",
    };
    const callback = vi.fn();

    const runtimeSession = { sessionDid: fakeSocket.data.sessionDid };
    fakeSessionManager.getRuntimeSession.mockResolvedValue(runtimeSession);
    fakeAuthService.verifyCollaborationToken.mockResolvedValue(true);

    const fakeUpdate = {
      id: "some-id",
      documentId: fakeArgs.documentId,
      data: fakeArgs.data,
      updateType: "yjs_update",
      committed: false,
      commitCid: null,
      createdAt: 1000,
      sessionDid: runtimeSession.sessionDid,
    };
    fakeMongoDBStore.createUpdate.mockResolvedValue(fakeUpdate);

    await handleDocumentUpdate(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(fakeSessionManager.getRuntimeSession).toHaveBeenCalledWith(
      fakeArgs.documentId,
      fakeSocket.data.sessionDid
    );
    expect(fakeAuthService.verifyCollaborationToken).toHaveBeenCalledWith(
      fakeArgs.collaborationToken,
      runtimeSession.sessionDid,
      fakeArgs.documentId
    );
    expect(fakeMongoDBStore.createUpdate).toHaveBeenCalledWith({
      id: expect.any(String),
      documentId: fakeArgs.documentId,
      data: fakeArgs.data,
      updateType: "yjs_update",
      committed: false,
      commitCid: null,
      createdAt: expect.any(Number),
      sessionDid: runtimeSession.sessionDid,
    });

    const roomName = getRoomName(fakeArgs.documentId!, fakeSocket.data.sessionDid);
    expect(fakeSocket.to).toHaveBeenCalledWith(roomName);
    expect(fakeBroadcastOperator.emit).toHaveBeenCalledWith("/document/content_update", {
      id: expect.any(String),
      data: fakeArgs.data,
      createdAt: expect.any(Number),
      roomId: fakeArgs.documentId,
    });

    expect(callback).toHaveBeenCalledWith({
      status: true,
      statusCode: 200,
      data: {
        id: expect.any(String),
        documentId: fakeUpdate.documentId,
        data: fakeUpdate.data,
        updateType: fakeUpdate.updateType,
        commitCid: fakeUpdate.commitCid,
        createdAt: expect.any(Number),
      },
    });
  });

  it("stamps the connection's appType onto the persisted update", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket({ emit: vi.fn() });
    fakeSocket.data.appType = "dsheet";
    const fakeArgs: DocumentUpdateArgs = {
      documentId: "doc-1",
      data: "update-data",
      collaborationToken: "token",
    };
    const callback = vi.fn();

    const runtimeSession = { sessionDid: fakeSocket.data.sessionDid };
    fakeSessionManager.getRuntimeSession.mockResolvedValue(runtimeSession);
    fakeAuthService.verifyCollaborationToken.mockResolvedValue(true);
    fakeMongoDBStore.createUpdate.mockResolvedValue({
      id: "u1",
      documentId: fakeArgs.documentId,
      data: fakeArgs.data,
      updateType: "yjs_update",
      committed: false,
      commitCid: null,
      createdAt: 1,
      sessionDid: runtimeSession.sessionDid,
      appType: "dsheet",
    });

    await handleDocumentUpdate(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(fakeMongoDBStore.createUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ appType: "dsheet" })
    );
  });

  it("does NOT broadcast to peers when the durable persist fails (persist-before-broadcast)", async () => {
    const fakeIO = createFakeIO();
    const fakeBroadcastOperator = { emit: vi.fn() };
    const fakeSocket = createFakeSocket(fakeBroadcastOperator);
    const fakeArgs: DocumentUpdateArgs = {
      documentId: "doc-1",
      data: "update-data",
      collaborationToken: "token",
    };
    const callback = vi.fn();

    const runtimeSession = { sessionDid: fakeSocket.data.sessionDid };
    fakeSessionManager.getRuntimeSession.mockResolvedValue(runtimeSession);
    fakeAuthService.verifyCollaborationToken.mockResolvedValue(true);
    fakeMongoDBStore.createUpdate.mockRejectedValue(new Error("db write failed"));

    await handleDocumentUpdate(deps, fakeIO, fakeSocket, fakeArgs, callback);

    // A peer must never hold an update absent from the durable seq stream.
    expect(fakeBroadcastOperator.emit).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 500,
      error: "Internal server error",
      errorCode: ErrorCode.INTERNAL_ERROR,
    });
  });

  it("returns 500 when an unexpected error occurs in document update handler", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket();
    const fakeArgs: DocumentUpdateArgs = {
      documentId: "doc-1",
      data: "update-data",
      collaborationToken: "token",
    };
    const callback = vi.fn();

    fakeSessionManager.getRuntimeSession.mockRejectedValue(new Error("db error"));

    await handleDocumentUpdate(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 500,
      error: "Internal server error",
      errorCode: ErrorCode.INTERNAL_ERROR,
    });
  });

  describe("handleDocumentUpdate — rail write-guard", () => {
    function makeEditor(
      railData: { rail: "gp" | "workspace" | "public"; admittedEditGrantEpoch?: number },
      broadcast?: { emit: ReturnType<typeof vi.fn> }
    ) {
      const socket = createFakeSocket(broadcast ?? { emit: vi.fn() }, { role: "editor" });
      socket.data.rail = railData.rail;
      if (railData.rail === "gp") socket.data.railKind = "gp-legacy";
      if (railData.admittedEditGrantEpoch !== undefined) {
        socket.data.admittedEditGrantEpoch = railData.admittedEditGrantEpoch;
      }
      fakeSessionManager.getRuntimeSession.mockResolvedValue({ sessionDid: socket.data.sessionDid });
      fakeAuthService.verifyCollaborationToken.mockResolvedValue(true);
      return socket;
    }
    const args = { documentId: "doc-1", data: "d", collaborationToken: "ct" } as DocumentUpdateArgs;

    it("403 EDIT_REVOKED when a GP editor's admitted epoch is now stale — no persist, no broadcast", async () => {
      const bcast = { emit: vi.fn() };
      const socket = makeEditor({ rail: "gp", admittedEditGrantEpoch: 2 }, bcast);
      (deps.gateEpochCache as any).getEditGrantEpoch.mockResolvedValue(5);
      const cb = vi.fn();
      await handleDocumentUpdate(deps, createFakeIO(), socket, args, cb);
      expect(cb).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403, errorCode: ErrorCode.EDIT_REVOKED }));
      expect(fakeMongoDBStore.createUpdate).not.toHaveBeenCalled();
      expect(bcast.emit).not.toHaveBeenCalled();
    });

    it("403 when a workspace editor's tier is now disabled", async () => {
      const socket = makeEditor({ rail: "workspace" });
      fakeSessionManager.getWorkspaceEditEnabled.mockResolvedValue(false);
      const cb = vi.fn();
      await handleDocumentUpdate(deps, createFakeIO(), socket, args, cb);
      expect(cb).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403, errorCode: ErrorCode.EDIT_REVOKED }));
      expect(fakeMongoDBStore.createUpdate).not.toHaveBeenCalled();
    });

    it("403 when a public editor's collabJoinEnabled is no longer true (false OR undefined)", async () => {
      for (const val of [false, undefined]) {
        vi.clearAllMocks();
        const socket = makeEditor({ rail: "public" });
        fakeSessionManager.getCollabJoinEnabled.mockResolvedValue(val);
        const cb = vi.fn();
        await handleDocumentUpdate(deps, createFakeIO(), socket, args, cb);
        expect(cb).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403, errorCode: ErrorCode.EDIT_REVOKED }));
        expect(fakeMongoDBStore.createUpdate).not.toHaveBeenCalled();
      }
    });

    it("persists for a GP editor whose epoch is still current", async () => {
      const socket = makeEditor({ rail: "gp", admittedEditGrantEpoch: 5 });
      (deps.gateEpochCache as any).getEditGrantEpoch.mockResolvedValue(5);
      fakeMongoDBStore.createUpdate.mockResolvedValue({ id: "u1", documentId: "doc-1", data: "d", updateType: "yjs_update", commitCid: null, createdAt: 1 });
      const cb = vi.fn();
      await handleDocumentUpdate(deps, createFakeIO(), socket, args, cb);
      expect(fakeMongoDBStore.createUpdate).toHaveBeenCalled();
      expect(cb).toHaveBeenCalledWith(expect.objectContaining({ status: true }));
    });

    it("persists for a GP editor when the gate epoch is unreachable (null — fail-open)", async () => {
      const socket = makeEditor({ rail: "gp", admittedEditGrantEpoch: 2 });
      (deps.gateEpochCache as any).getEditGrantEpoch.mockResolvedValue(null);
      fakeMongoDBStore.createUpdate.mockResolvedValue({ id: "u1", documentId: "doc-1", data: "d", updateType: "yjs_update", commitCid: null, createdAt: 1 });
      const cb = vi.fn();
      await handleDocumentUpdate(deps, createFakeIO(), socket, args, cb);
      expect(fakeMongoDBStore.createUpdate).toHaveBeenCalled();
      expect(cb).toHaveBeenCalledWith(expect.objectContaining({ status: true }));
    });

    it("does NOT guard a dsheet editor (no rail model — must not 403)", async () => {
      const socket = createFakeSocket({ emit: vi.fn() }, { role: "editor" });
      socket.data.appType = "dsheet"; // excluded from the ddoc-only guard
      fakeSessionManager.getRuntimeSession.mockResolvedValue({ sessionDid: socket.data.sessionDid });
      fakeAuthService.verifyCollaborationToken.mockResolvedValue(true);
      fakeMongoDBStore.createUpdate.mockResolvedValue({ id: "u1", documentId: "doc-1", data: "d", updateType: "yjs_update", commitCid: null, createdAt: 1 });
      const cb = vi.fn();
      await handleDocumentUpdate(deps, createFakeIO(), socket, args, cb);
      expect(fakeMongoDBStore.createUpdate).toHaveBeenCalled();
      expect(cb).toHaveBeenCalledWith(expect.objectContaining({ status: true }));
    });
  });
});

