import { describe, vi, it, expect, beforeEach } from "vitest";
import { handleSetDocumentMeta } from "../../services/socket-handlers";
import type { SocketHandlerDeps } from "../../services/socket-handlers.deps";
import type { AppSocket } from "../../types";
import { ErrorCode } from "../../types";

function fakeSocket(
  role: "owner" | "editor",
  broadcastOperator?: { emit: ReturnType<typeof vi.fn> }
): AppSocket {
  const toReturn = broadcastOperator ?? { emit: vi.fn() };
  return {
    id: "s1",
    data: { authenticated: true, documentId: "doc-1", sessionDid: "room-did", role, appType: "ddoc" },
    to: vi.fn(() => toReturn),
  } as unknown as AppSocket;
}

describe("handleSetDocumentMeta", () => {
  const upsertDocumentMeta = vi.fn();
  const getRuntimeSession = vi.fn().mockResolvedValue({ sessionDid: "room-did", ownerDid: "od", ownerIdentityDid: "oid", portalAddress: "0xP" });
  const deps: SocketHandlerDeps = {
    authService: {} as any,
    sessionManager: { getRuntimeSession } as any,
    mongodbStore: { upsertDocumentMeta } as any,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a non-owner", async () => {
    const cb = vi.fn();
    const broadcast = { emit: vi.fn() };
    const socket = fakeSocket("editor", broadcast);
    await handleSetDocumentMeta(deps, socket, { editLock: "el", title: "t" }, cb);
    expect(upsertDocumentMeta).not.toHaveBeenCalled();
    expect(broadcast.emit).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403, errorCode: ErrorCode.COMMIT_UNAUTHORIZED }));
  });

  it("persists editLock + title for the owner", async () => {
    const cb = vi.fn();
    await handleSetDocumentMeta(deps, fakeSocket("owner"), { editLock: "el", title: "t" }, cb);
    expect(upsertDocumentMeta).toHaveBeenCalledWith(expect.objectContaining({
      documentId: "doc-1", sessionDid: "room-did", ownerDid: "od", ownerIdentityDid: "oid", editLock: "el", title: "t",
    }));
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ status: true, statusCode: 200 }));
  });

  it("broadcasts the meta update to room peers, not back to the sender", async () => {
    const cb = vi.fn();
    const broadcast = { emit: vi.fn() };
    const socket = fakeSocket("owner", broadcast);
    await handleSetDocumentMeta(deps, socket, { editLock: "el", title: "enc-title" }, cb);
    expect(socket.to).toHaveBeenCalledWith("session::doc-1__room-did");
    expect(broadcast.emit).toHaveBeenCalledWith("/document/meta_update", {
      roomId: "doc-1",
      title: "enc-title",
    });
  });

  it("broadcasts a null title", async () => {
    const cb = vi.fn();
    const broadcast = { emit: vi.fn() };
    const socket = fakeSocket("owner", broadcast);
    await handleSetDocumentMeta(deps, socket, { editLock: "el", title: null }, cb);
    expect(broadcast.emit).toHaveBeenCalledWith("/document/meta_update", {
      roomId: "doc-1",
      title: null,
    });
  });

  it("does not broadcast when the session lookup fails", async () => {
    const cb = vi.fn();
    const broadcast = { emit: vi.fn() };
    const socket = fakeSocket("owner", broadcast);
    getRuntimeSession.mockResolvedValueOnce(null);
    await handleSetDocumentMeta(deps, socket, { editLock: "el", title: "t" }, cb);
    expect(broadcast.emit).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });
});
