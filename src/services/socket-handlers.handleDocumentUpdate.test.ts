import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleDocumentUpdate, getRoomName } from "./socket-handlers";
import type { AppServer, AppSocket, DocumentUpdateArgs } from "../types";
import type { SocketHandlerDeps } from "./socket-handlers.deps";

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
  };
  const fakeMongoDBStore = {
    createUpdate: vi.fn(),
  };

  const deps: SocketHandlerDeps = {
    authService: fakeAuthService as any,
    sessionManager: fakeSessionManager as any,
    mongodbStore: fakeMongoDBStore as any,
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

    expect(fakeAuthService.verifyCollaborationToken).toHaveBeenCalledWith(
      fakeArgs.collaborationToken,
      runtimeSession.sessionDid,
      fakeArgs.documentId
    );
    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 401,
      error: "Authentication failed",
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
      id: "update-id",
      documentId: fakeArgs.documentId,
      data: fakeArgs.data,
      updateType: "yjs_update",
      committed: false,
      commitCid: null,
      createdAt: 123456,
      sessionDid: runtimeSession.sessionDid,
    };
    fakeMongoDBStore.createUpdate.mockResolvedValue(fakeUpdate);

    await handleDocumentUpdate(deps, fakeIO, fakeSocket, fakeArgs, callback);

    expect(fakeMongoDBStore.createUpdate).toHaveBeenCalled();

    const roomName = getRoomName(fakeArgs.documentId!, fakeSocket.data.sessionDid);
    expect(fakeSocket.to).toHaveBeenCalledWith(roomName);
    expect(fakeBroadcastOperator.emit).toHaveBeenCalledWith("/document/content_update", {
      id: fakeUpdate.id,
      data: fakeUpdate.data,
      createdAt: fakeUpdate.createdAt,
      roomId: fakeArgs.documentId,
    });

    expect(callback).toHaveBeenCalledWith({
      status: true,
      statusCode: 200,
      data: {
        id: fakeUpdate.id,
        documentId: fakeUpdate.documentId,
        data: fakeUpdate.data,
        updateType: fakeUpdate.updateType,
        commitCid: fakeUpdate.commitCid,
        createdAt: fakeUpdate.createdAt,
      },
    });
  });
}
);

