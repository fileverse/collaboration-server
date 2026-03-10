import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleDocumentCommit } from "./socket-handlers";
import type { AppSocket, DocumentCommitArgs } from "../types";
import type { SocketHandlerDeps } from "./socket-handlers.deps";
import { ErrorCode } from "../types";

function createFakeSocket(
  dataOverrides?: Partial<{
    authenticated: boolean;
    documentId: string;
    sessionDid: string;
    role: "owner" | "editor";
  }>
): AppSocket {
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
  } as unknown as AppSocket;
}

describe("handleDocumentCommit", () => {
  const fakeAuthService = {
    verifyOwnerToken: vi.fn(),
  };
  const fakeSessionManager = {
    getRuntimeSession: vi.fn(),
  };
  const fakeMongoDBStore = {
    createCommit: vi.fn(),
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
    const fakeSocket = createFakeSocket({ authenticated: false });
    const fakeArgs: DocumentCommitArgs = {
      documentId: "doc-1",
      updates: ["u1"],
      cid: "cid-1",
      ownerToken: "owner-token",
      ownerAddress: "0xowner",
      contractAddress: "0xcontract",
    };
    const callback = vi.fn();

    await handleDocumentCommit(deps, fakeSocket, fakeArgs, callback);

    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 401,
      error: "Not authenticated or session not found",
      errorCode: "NOT_AUTHENTICATED",
    });
  });

  it("returns 403 when socket role is not owner", async () => {
    const fakeSocket = createFakeSocket({ role: "editor" });
    const fakeArgs: DocumentCommitArgs = {
      documentId: "doc-1",
      updates: ["u1"],
      cid: "cid-1",
      ownerToken: "owner-token",
      ownerAddress: "0xowner",
      contractAddress: "0xcontract",
    };
    const callback = vi.fn();

    await handleDocumentCommit(deps, fakeSocket, fakeArgs, callback);

    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 403,
      error: "Only owners can create commits",
      errorCode: "COMMIT_UNAUTHORIZED",
    });
  });

  it("returns 404 when runtime session is not found", async () => {
    const fakeSocket = createFakeSocket();
    const fakeArgs: DocumentCommitArgs = {
      documentId: "doc-1",
      updates: ["u1"],
      cid: "cid-1",
      ownerToken: "owner-token",
      ownerAddress: "0x0000000000000000000000000000000000000001",
      contractAddress: "0x0000000000000000000000000000000000000002",
    };
    const callback = vi.fn();

    fakeSessionManager.getRuntimeSession.mockResolvedValue(undefined);

    await handleDocumentCommit(deps, fakeSocket, fakeArgs, callback);

    expect(fakeSessionManager.getRuntimeSession).toHaveBeenCalledWith(
      fakeArgs.documentId,
      fakeSocket.data.sessionDid
    );
    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 404,
      error: "Session not found",
      errorCode: "SESSION_NOT_FOUND",
    });
  });

  it("returns 400 when updates or cid are missing or invalid", async () => {
    const fakeSocket = createFakeSocket();
    const callback = vi.fn();

    const badArgsList: DocumentCommitArgs[] = [
      // @ts-expect-error testing missing required fields (updates, cid, owner fields)
      {
        documentId: "doc-1",
      },
      {
        documentId: "doc-1",
        // deliberately non-array to test validation
        updates: null as any,
        cid: "cid-1",
        ownerToken: "owner-token",
        ownerAddress: "0x0000000000000000000000000000000000000001",
        contractAddress: "0x0000000000000000000000000000000000000002",
      },
      {
        documentId: "doc-1",
        updates: ["u1"],
        cid: "" as any,
        ownerToken: "owner-token",
        ownerAddress: "0x0000000000000000000000000000000000000001",
        contractAddress: "0x0000000000000000000000000000000000000002",
      },
    ];

    for (const badArgs of badArgsList) {
      const runtimeSession = { sessionDid: fakeSocket.data.sessionDid };
      fakeSessionManager.getRuntimeSession.mockResolvedValue(runtimeSession);
      fakeAuthService.verifyOwnerToken.mockResolvedValue(true);

      await handleDocumentCommit(deps, fakeSocket, badArgs as any, callback);

      expect(callback).toHaveBeenLastCalledWith({
        status: false,
        statusCode: 400,
        error: "Updates array and CID are required",
        errorCode: "COMMIT_MISSING_DATA",
      });
    }
  });

  it("returns 400 when contract or owner address format is invalid", async () => {
    const fakeSocket = createFakeSocket();
    const fakeArgs: DocumentCommitArgs = {
      documentId: "doc-1",
      updates: ["u1"],
      cid: "cid-1",
      ownerToken: "owner-token",
      ownerAddress: "not-a-valid-address",
      contractAddress: "0x0000000000000000000000000000000000000002",
    };
    const callback = vi.fn();

    const runtimeSession = { sessionDid: fakeSocket.data.sessionDid };
    fakeSessionManager.getRuntimeSession.mockResolvedValue(runtimeSession);

    await handleDocumentCommit(deps, fakeSocket, fakeArgs, callback);

    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 400,
      error: "Invalid contract address or owner address format",
      errorCode: ErrorCode.INVALID_ADDRESS,
    });
    expect(fakeAuthService.verifyOwnerToken).not.toHaveBeenCalled();
  });

  it("returns 401 when owner token verification fails", async () => {
    const fakeSocket = createFakeSocket();
    const fakeArgs: DocumentCommitArgs = {
      documentId: "doc-1",
      updates: ["u1"],
      cid: "cid-1",
      ownerToken: "owner-token",
      ownerAddress: "0x0000000000000000000000000000000000000001",
      contractAddress: "0x0000000000000000000000000000000000000002",
    };
    const callback = vi.fn();

    const runtimeSession = { sessionDid: fakeSocket.data.sessionDid };
    fakeSessionManager.getRuntimeSession.mockResolvedValue(runtimeSession);
    fakeAuthService.verifyOwnerToken.mockResolvedValue(false);

    await handleDocumentCommit(deps, fakeSocket, fakeArgs, callback);
    expect(fakeSessionManager.getRuntimeSession).toHaveBeenCalledWith(
      fakeArgs.documentId,
      fakeSocket.data.sessionDid
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
      errorCode: "AUTH_TOKEN_INVALID",
    });
  });

  it("creates commit when all checks pass", async () => {
    const fakeSocket = createFakeSocket();
    const fakeArgs: DocumentCommitArgs = {
      documentId: "doc-1",
      updates: ["u1", "u2"],
      cid: "cid-1",
      ownerToken: "owner-token",
      ownerAddress: "0x0000000000000000000000000000000000000001",
      contractAddress: "0x0000000000000000000000000000000000000002",
    };
    const callback = vi.fn();

    const runtimeSession = { sessionDid: fakeSocket.data.sessionDid };
    fakeSessionManager.getRuntimeSession.mockResolvedValue(runtimeSession);
    fakeAuthService.verifyOwnerToken.mockResolvedValue(true);

    const fakeCommit = {
      id: "commit-id",
      documentId: fakeArgs.documentId,
      cid: fakeArgs.cid,
      updates: fakeArgs.updates,
      createdAt: 123456,
      sessionDid: runtimeSession.sessionDid,
    };
    fakeMongoDBStore.createCommit.mockResolvedValue(fakeCommit);

    await handleDocumentCommit(deps, fakeSocket, fakeArgs, callback);
    expect(fakeSessionManager.getRuntimeSession).toHaveBeenCalledWith(
      fakeArgs.documentId,
      fakeSocket.data.sessionDid
    );
    expect(fakeMongoDBStore.createCommit).toHaveBeenCalledWith({
      id: expect.any(String),
      documentId: fakeArgs.documentId,
      cid: fakeArgs.cid,
      updates: fakeArgs.updates,
      createdAt: expect.any(Number),
      sessionDid: runtimeSession.sessionDid,
    });

    expect(callback).toHaveBeenCalledWith({
      status: true,
      statusCode: 200,
      data: {
        cid: fakeCommit.cid,
        createdAt: fakeCommit.createdAt,
        documentId: fakeCommit.documentId,
        updates: fakeCommit.updates,
      },
    });
  });

  it("returns 500 when an unexpected error occurs in document commit handler", async () => {
    const fakeSocket = createFakeSocket();
    const fakeArgs: DocumentCommitArgs = {
      documentId: "doc-1",
      updates: ["u1"],
      cid: "cid-1",
      ownerToken: "owner-token",
      ownerAddress: "0x0000000000000000000000000000000000000001",
      contractAddress: "0x0000000000000000000000000000000000000002",
    };
    const callback = vi.fn();

    fakeSessionManager.getRuntimeSession.mockRejectedValue(new Error("db error"));

    await handleDocumentCommit(deps, fakeSocket, fakeArgs, callback);

    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 500,
      error: "Internal server error",
      errorCode: ErrorCode.INTERNAL_ERROR,
    });
  });
});

