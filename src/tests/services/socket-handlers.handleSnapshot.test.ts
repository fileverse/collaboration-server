import { describe, vi, it, expect, beforeEach } from "vitest";
import { handleSnapshot } from "../../services/socket-handlers";
import type { SocketHandlerDeps } from "../../services/socket-handlers.deps";
import type { AppSocket } from "../../types";
import { ErrorCode } from "../../types";

function fakeSocket(role: "owner" | "editor"): AppSocket {
  return {
    id: "socket-1",
    data: { authenticated: true, documentId: "doc-1", sessionDid: "room-did", role, appType: "ddoc" },
  } as unknown as AppSocket;
}

describe("handleSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createSnapshot = vi.fn();
  const verifyCollaborationToken = vi.fn().mockResolvedValue(true);
  const getRuntimeSession = vi.fn().mockResolvedValue({ sessionDid: "room-did" });
  const deps: SocketHandlerDeps = {
    authService: { verifyCollaborationToken } as any,
    sessionManager: { getRuntimeSession } as any,
    mongodbStore: { createSnapshot } as any,
    gateEpochCache: {} as any,
    editBoundCache: {} as any,
  };

  it("rejects a non-owner with 403", async () => {
    const cb = vi.fn();
    await handleSnapshot(deps, fakeSocket("editor"), { data: "ct", collaborationToken: "t", floorSeq: 1 }, cb);
    expect(createSnapshot).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ status: false, statusCode: 403, errorCode: ErrorCode.COMMIT_UNAUTHORIZED }));
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
});
