import { describe, vi, it, expect, beforeEach } from "vitest";
import { handleSnapshot } from "../../services/socket-handlers";
import type { SocketHandlerDeps } from "../../services/socket-handlers.deps";
import type { AppSocket } from "../../types";
import { ErrorCode } from "../../types";

function fakeSocket(role: "owner" | "editor", extra: Record<string, unknown> = {}): AppSocket {
  return {
    id: "socket-1",
    data: { authenticated: true, documentId: "doc-1", sessionDid: "room-did", role, appType: "ddoc", ...extra },
  } as unknown as AppSocket;
}

describe("handleSnapshot", () => {
  const createSnapshot = vi.fn();
  const getCurrentSeq = vi.fn();
  const verifyCollaborationToken = vi.fn();
  const getRuntimeSession = vi.fn();
  const getCollabJoinEnabled = vi.fn();
  const deps: SocketHandlerDeps = {
    authService: { verifyCollaborationToken } as any,
    sessionManager: { getRuntimeSession, getCollabJoinEnabled } as any,
    mongodbStore: { createSnapshot, getCurrentSeq } as any,
    editBoundCache: { check: vi.fn() } as any,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    verifyCollaborationToken.mockResolvedValue(true);
    getRuntimeSession.mockResolvedValue({ sessionDid: "room-did" });
    getCurrentSeq.mockResolvedValue(100);
  });

  it("rejects a revoked editor with 403", async () => {
    getCollabJoinEnabled.mockResolvedValue(false);
    const cb = vi.fn();
    await handleSnapshot(deps, fakeSocket("editor"), { data: "ct", collaborationToken: "t", floorSeq: 1 }, cb);
    expect(createSnapshot).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ status: false, statusCode: 403, errorCode: ErrorCode.EDIT_REVOKED }));
  });

  it("persists an admitted editor's snapshot (compaction is not owner-only)", async () => {
    getCollabJoinEnabled.mockResolvedValue(true);
    createSnapshot.mockResolvedValue({ id: "s1", documentId: "doc-1", seq: 9 });
    const cb = vi.fn();
    await handleSnapshot(deps, fakeSocket("editor"), { data: "ct", collaborationToken: "t", floorSeq: 4 }, cb);
    expect(createSnapshot).toHaveBeenCalledWith(expect.objectContaining({ documentId: "doc-1", updateType: "snapshot", floorSeq: 4 }));
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ status: true, statusCode: 200 }));
  });

  it("persists an owner snapshot and acks", async () => {
    createSnapshot.mockResolvedValue({ id: "s1", documentId: "doc-1", seq: 9 });
    const cb = vi.fn();
    await handleSnapshot(deps, fakeSocket("owner"), { data: "ct", collaborationToken: "t", publishedMarker: "blk-1", floorSeq: 4 }, cb);
    expect(createSnapshot).toHaveBeenCalledWith(expect.objectContaining({ documentId: "doc-1", data: "ct", updateType: "snapshot", sessionDid: "room-did", publishedMarker: "blk-1", floorSeq: 4 }));
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ status: true, statusCode: 200 }));
  });

  it("rejects an owner snapshot missing a valid floorSeq with 400", async () => {
    const cb = vi.fn();
    // floorSeq omitted — a snapshot with no proven floor would let hydration serve
    // seq > snapshot.seq and orphan a concurrent writer's update, so it must be rejected.
    await handleSnapshot(deps, fakeSocket("owner"), { data: "ct", collaborationToken: "t" } as any, cb);
    expect(createSnapshot).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ status: false, statusCode: 400 }));
  });

  it("rejects a floorSeq ahead of the document's seq counter with 400", async () => {
    getCurrentSeq.mockResolvedValue(10);
    const cb = vi.fn();
    // A floor ahead of the counter would hide every update row up to it from hydration.
    await handleSnapshot(deps, fakeSocket("owner"), { data: "ct", collaborationToken: "t", floorSeq: 11 }, cb);
    expect(createSnapshot).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ status: false, statusCode: 400 }));
  });

  it("accepts a floorSeq equal to the current counter", async () => {
    getCurrentSeq.mockResolvedValue(10);
    createSnapshot.mockResolvedValue({ id: "s1", documentId: "doc-1", seq: 11 });
    const cb = vi.fn();
    await handleSnapshot(deps, fakeSocket("owner"), { data: "ct", collaborationToken: "t", floorSeq: 10 }, cb);
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ status: true, statusCode: 200 }));
  });
});
