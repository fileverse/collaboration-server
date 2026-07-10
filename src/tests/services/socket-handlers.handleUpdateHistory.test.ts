import { describe, vi, it, expect, beforeEach } from "vitest";
import { handleUpdateHistory } from "../../services/socket-handlers";
import type { SocketHandlerDeps } from "../../services/socket-handlers.deps";
import type { AppSocket, UpdateHistoryArgs } from "../../types";
import { ErrorCode } from "../../types";

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

  const fakeMongodbStore = { getHydrationRange: vi.fn() };

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
      errorCode: ErrorCode.NOT_AUTHENTICATED,
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
      errorCode: ErrorCode.NOT_AUTHENTICATED,
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
      errorCode: ErrorCode.NOT_AUTHENTICATED,
    });
  });

  it("serves snapshot + tail as an ordered history array", async () => {
    const fakeSocket = createFakeSocket(undefined, { documentId: "doc-1" });
    const snapshot = { id: "s1", documentId: "doc-1", seq: 10, data: "ct", updateType: "snapshot", committed: false, commitCid: null, createdAt: 1, sessionDid: "test-session-did" };
    const updates = [{ id: "u11", documentId: "doc-1", seq: 11, data: "ct", updateType: "yjs_update", committed: false, commitCid: null, createdAt: 2, sessionDid: "test-session-did" }];
    fakeMongodbStore.getHydrationRange.mockResolvedValue({ snapshot, updates, nextSeq: null, hasMore: false });
    const cb = vi.fn();

    await handleUpdateHistory(deps, fakeSocket, { documentId: "doc-1" }, cb);

    expect(fakeMongodbStore.getHydrationRange).toHaveBeenCalledWith("doc-1", "test-session-did", { sinceSeq: undefined });
    expect(cb).toHaveBeenCalledWith({ status: true, statusCode: 200, data: { history: [snapshot, ...updates], total: 2, snapshot, nextSeq: null, hasMore: false } });
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

    fakeMongodbStore.getHydrationRange.mockRejectedValue(new Error("db error"));

    await handleUpdateHistory(deps, fakeSocket, fakeArgs, fakeCallback);

    expect(fakeCallback).toHaveBeenCalledWith({
      status: false,
      statusCode: 500,
      error: "Internal server error",
      errorCode: ErrorCode.INTERNAL_ERROR,
    });
  });
});