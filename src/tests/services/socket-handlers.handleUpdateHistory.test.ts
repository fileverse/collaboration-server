import { describe, vi, it, expect, beforeEach } from "vitest";
import { handleUpdateHistory } from "../../services/socket-handlers";
import type { SocketHandlerDeps } from "../../services/socket-handlers.deps";
import type { AppSocket, DocumentUpdate, UpdateHistoryArgs } from "../../types";

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

describe("updateHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const fakeMongodbStore = {
    getUpdatesByDocument: vi.fn(),
    countUpdatesByDocument: vi.fn(),
  };

  const deps: SocketHandlerDeps = {
    authService: {} as any,
    sessionManager: {} as any,
    mongodbStore: fakeMongodbStore as any,
  };

  it("returns early when not authenticated", async () => {
    const fakeSocket: AppSocket = createFakeSocket(undefined, { authenticated: false });
    const fakeArgs: UpdateHistoryArgs = {
      documentId: "test-document-id",
    };
    const fakeCallback = vi.fn();

    await handleUpdateHistory(deps, fakeSocket, fakeArgs, fakeCallback);

    expect(fakeCallback).toHaveBeenCalledWith({
      status: false,
      statusCode: 401,
      error: "Not authenticated",
      errorCode: "NOT_AUTHENTICATED",
    });
  });

  it("returns early when documentId is empty in socket data", async () => {
    const fakeSocket: AppSocket = createFakeSocket(undefined, { documentId: "" });
    const fakeArgs: UpdateHistoryArgs = {};
    const fakeCallback = vi.fn();

    await handleUpdateHistory(deps, fakeSocket, fakeArgs, fakeCallback);

    expect(fakeCallback).toHaveBeenCalledWith({
      status: false,
      statusCode: 401,
      error: "Not authenticated",
      errorCode: "NOT_AUTHENTICATED",
    });
  });

  it("returns early when sessionDid is empty in socket data", async () => {
    const fakeSocket: AppSocket = createFakeSocket(undefined, { sessionDid: "" });
    const fakeArgs: UpdateHistoryArgs = {
      documentId: "test-document-id",
    };
    const fakeCallback = vi.fn();

    await handleUpdateHistory(deps, fakeSocket, fakeArgs, fakeCallback);

    expect(fakeCallback).toHaveBeenCalledWith({
      status: false,
      statusCode: 401,
      error: "Not authenticated",
      errorCode: "NOT_AUTHENTICATED",
    });
  });

  it("returns update history successfully, with fallback argument values", async () => {
    const fakeSocket: AppSocket = createFakeSocket(undefined, {
      documentId: "test-document-id",
    });
    const fakeArgs: UpdateHistoryArgs = {
      documentId: "test-document-id",
    };
    const fakeCallback = vi.fn();
    const fakeResponse: DocumentUpdate[] = [];
    const documentId = fakeArgs.documentId || fakeSocket.data.documentId;

    fakeMongodbStore.getUpdatesByDocument.mockResolvedValue(fakeResponse);
    fakeMongodbStore.countUpdatesByDocument.mockResolvedValue(fakeResponse.length);

    await handleUpdateHistory(deps, fakeSocket, fakeArgs, fakeCallback);

    expect(fakeMongodbStore.getUpdatesByDocument).toHaveBeenCalledWith(
      {
        documentId,
        sessionDid: fakeSocket.data.sessionDid,
      },
      {
        offset: 0,
        limit: 100,
        sort: "desc",
        committed: undefined,
      }
    );
    expect(fakeMongodbStore.countUpdatesByDocument).toHaveBeenCalledWith(
      {
        documentId,
        sessionDid: fakeSocket.data.sessionDid,
      },
      { committed: undefined },
    );

    expect(fakeCallback).toHaveBeenCalledWith({
      status: true,
      statusCode: 200,
      data: {
        history: [],
        total: fakeResponse.length,
      },
    });
  });

  it("returns update history successfully with proper argument values set", async () => {
    const fakeSocket: AppSocket = createFakeSocket();
    const fakeArgs: UpdateHistoryArgs = {
      documentId: "test-document-id",
      limit: 1000,
      offset: 0,
      filters: {
        committed: false,
      },
      sort: "desc",
    };
    const fakeCallback = vi.fn();
    const fakeResponse: DocumentUpdate[] = [
      {
        id: "test-id",
        documentId: "test-document-id",
        data: "test-encrypted-data",
        updateType: "yjs_update",
        committed: false,
        commitCid: null,
        createdAt: 1772181495470,
        sessionDid: "test-session-did",
      },
    ];
    const documentId = fakeArgs.documentId || fakeSocket.data.documentId;

    fakeMongodbStore.getUpdatesByDocument.mockResolvedValue(fakeResponse);
    fakeMongodbStore.countUpdatesByDocument.mockResolvedValue(fakeResponse.length);

    await handleUpdateHistory(deps, fakeSocket, fakeArgs, fakeCallback);

    expect(fakeMongodbStore.getUpdatesByDocument).toHaveBeenCalledWith(
      {
        documentId,
        sessionDid: fakeSocket.data.sessionDid,
      },
      {
        offset: fakeArgs.offset,
        limit: fakeArgs.limit,
        sort: fakeArgs.sort,
        committed: fakeArgs.filters?.committed,
      }
    );
    expect(fakeMongodbStore.countUpdatesByDocument).toHaveBeenCalledWith(
      {
        documentId,
        sessionDid: fakeSocket.data.sessionDid,
      },
      { committed: fakeArgs.filters?.committed },
    );

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
    const fakeArgs: UpdateHistoryArgs = {
      documentId: "test-document-id",
      limit: 1000,
      offset: 0,
      filters: {
        committed: false,
      },
      sort: "desc",
    };
    const fakeCallback = vi.fn();
    const documentId = fakeArgs.documentId || fakeSocket.data.documentId;

    fakeMongodbStore.getUpdatesByDocument.mockRejectedValue(new Error("db error"));
    fakeMongodbStore.countUpdatesByDocument.mockResolvedValue(0);

    await handleUpdateHistory(deps, fakeSocket, fakeArgs, fakeCallback);

    expect(fakeMongodbStore.getUpdatesByDocument).toHaveBeenCalledWith(
      {
        documentId,
        sessionDid: fakeSocket.data.sessionDid,
      },
      {
        offset: 0,
        limit: 1000,
        sort: "desc",
        committed: false,
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