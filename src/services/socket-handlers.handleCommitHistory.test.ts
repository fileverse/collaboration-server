import { describe, vi, it, expect, beforeEach } from "vitest";
import { handleCommitHistory } from "./socket-handlers";
import type { SocketHandlerDeps } from "./socket-handlers.deps";
import type { AppSocket, DocumentCommit, CommitHistoryArgs } from "../types";

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

describe("commitHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const fakeMongodbStore = {
    getCommitsByDocument: vi.fn(),
    countCommitsByDocument: vi.fn(),
  };

  const deps: SocketHandlerDeps = {
    authService: {} as any,
    sessionManager: {} as any,
    mongodbStore: fakeMongodbStore as any,
  };

  it("returns early when not authenticated", async () => {
    const fakeSocket: AppSocket = createFakeSocket(undefined, { authenticated: false });
    const fakeArgs: CommitHistoryArgs = {
      documentId: "test-document-id",
    };
    const fakeCallback = vi.fn();

    await handleCommitHistory(deps, fakeSocket, fakeArgs, fakeCallback);

    expect(fakeCallback).toHaveBeenCalledWith({
      status: false,
      statusCode: 401,
      error: "Not authenticated",
      errorCode: "NOT_AUTHENTICATED",
    });
  });

  it("returns early when documentId is empty in socket data", async () => {
    const fakeSocket: AppSocket = createFakeSocket(undefined, { documentId: "" });
    const fakeArgs: CommitHistoryArgs = {};
    const fakeCallback = vi.fn();

    await handleCommitHistory(deps, fakeSocket, fakeArgs, fakeCallback);

    expect(fakeCallback).toHaveBeenCalledWith({
      status: false,
      statusCode: 401,
      error: "Not authenticated",
      errorCode: "NOT_AUTHENTICATED",
    });
  });

  it("returns early when sessionDid is empty in socket data", async () => {
    const fakeSocket: AppSocket = createFakeSocket(undefined, { sessionDid: "" });
    const fakeArgs: CommitHistoryArgs = {
      documentId: "test-document-id",
    };
    const fakeCallback = vi.fn();

    await handleCommitHistory(deps, fakeSocket, fakeArgs, fakeCallback);

    expect(fakeCallback).toHaveBeenCalledWith({
      status: false,
      statusCode: 401,
      error: "Not authenticated",
      errorCode: "NOT_AUTHENTICATED",
    });
  });

  it("returns commit history successfully, with fallback argument values", async () => {
    const fakeSocket: AppSocket = createFakeSocket();
    const fakeArgs: CommitHistoryArgs = {};
    const fakeCallback = vi.fn();
    const fakeResponse: DocumentCommit[] = [];
    const documentId = fakeArgs.documentId || fakeSocket.data.documentId;

    fakeMongodbStore.getCommitsByDocument.mockResolvedValue(fakeResponse);
    fakeMongodbStore.countCommitsByDocument.mockResolvedValue(fakeResponse.length);

    await handleCommitHistory(deps, fakeSocket, fakeArgs, fakeCallback);

    expect(fakeMongodbStore.getCommitsByDocument).toHaveBeenCalledWith(
      { documentId, sessionDid: fakeSocket.data.sessionDid },
      { offset: 0, limit: 10, sort: "desc" }
    );
    expect(fakeMongodbStore.countCommitsByDocument).toHaveBeenCalledWith({
      documentId,
      sessionDid: fakeSocket.data.sessionDid,
    });

    expect(fakeCallback).toHaveBeenCalledWith({
      status: true,
      statusCode: 200,
      data: {
        history: fakeResponse,
        total: fakeResponse.length,
      },
    });
  });

  it("returns update history successfully with proper argument values set", async () => {
    const fakeSocket: AppSocket = createFakeSocket();
    const fakeArgs: CommitHistoryArgs = {
      documentId: "test-document-id",
      limit: 15,
      offset: 0,
      sort: "desc",
    };
    const fakeCallback = vi.fn();
    const fakeResponse: DocumentCommit[] = [];
    const documentId = fakeArgs.documentId || fakeSocket.data.documentId;

    fakeMongodbStore.getCommitsByDocument.mockResolvedValue(fakeResponse);
    fakeMongodbStore.countCommitsByDocument.mockResolvedValue(fakeResponse.length);

    await handleCommitHistory(deps, fakeSocket, fakeArgs, fakeCallback);

    expect(fakeMongodbStore.getCommitsByDocument).toHaveBeenCalledWith(
      { documentId, sessionDid: fakeSocket.data.sessionDid },
      { offset: fakeArgs.offset, limit: fakeArgs.limit, sort: fakeArgs.sort }
    );
    expect(fakeMongodbStore.countCommitsByDocument).toHaveBeenCalledWith({
      documentId,
      sessionDid: fakeSocket.data.sessionDid,
    });

    expect(fakeCallback).toHaveBeenCalledWith({
      status: true,
      statusCode: 200,
      data: {
        history: fakeResponse,
        total: fakeResponse.length,
      },
    });
  });

  it("returns 500 due to db operation error", async () => {
    const fakeSocket: AppSocket = createFakeSocket();
    const fakeArgs: CommitHistoryArgs = {
      documentId: "test-document-id",
      limit: 15,
      offset: 0,
      sort: "desc",
    };
    const fakeCallback = vi.fn();
    const documentId = fakeArgs.documentId || fakeSocket.data.documentId;

    fakeMongodbStore.getCommitsByDocument.mockRejectedValue(new Error("db error"));
    fakeMongodbStore.countCommitsByDocument.mockResolvedValue(0);

    await handleCommitHistory(deps, fakeSocket, fakeArgs, fakeCallback);

    expect(fakeMongodbStore.getCommitsByDocument).toHaveBeenCalledWith(
      {
        documentId,
        sessionDid: fakeSocket.data.sessionDid,
      },
      {
        offset: fakeArgs.offset,
        limit: fakeArgs.limit,
        sort: fakeArgs.sort,
      }
    );

    expect(fakeCallback).toHaveBeenCalledWith({
      status: false,
      statusCode: 500,
      error: "Internal server error",
      errorCode: "INTERNAL_ERROR",
    });
  });
});