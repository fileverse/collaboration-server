import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleMirrorSnapshot } from "../../services/socket-handlers";
import { ErrorCode } from "../../types";

function socket(data: any) {
  return { id: "s1", data: { authenticated: true, documentId: "doc-1", sessionDid: "sess-1", ...data } } as any;
}

describe("handleMirrorSnapshot", () => {
  let deps: any;
  beforeEach(() => {
    vi.clearAllMocks();
    deps = {
      sessionManager: { getRuntimeSession: vi.fn().mockResolvedValue({ sessionDid: "sess-1" }) },
      mongodbStore: { upsertMirrorSnapshot: vi.fn().mockResolvedValue(undefined) },
    };
  });

  it("401s when not authenticated", async () => {
    const cb = vi.fn();
    await handleMirrorSnapshot(deps, socket({ authenticated: false, role: "editor", rail: "gp" }), { data: "ct", fileKeyEpoch: 1 } as any, cb);
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it("403s an authenticated socket that is neither owner nor an admitted rail editor", async () => {
    const cb = vi.fn();
    await handleMirrorSnapshot(deps, socket({ role: "editor" }), { data: "ct", fileKeyEpoch: 1 } as any, cb);
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    expect(deps.mongodbStore.upsertMirrorSnapshot).not.toHaveBeenCalled();
  });

  it("400s on a missing/invalid fileKeyEpoch", async () => {
    const cb = vi.fn();
    await handleMirrorSnapshot(deps, socket({ role: "owner" }), { data: "ct" } as any, cb);
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(deps.mongodbStore.upsertMirrorSnapshot).not.toHaveBeenCalled();
  });

  it("400s (no persist) on an out-of-range fileKeyEpoch that would shadow the keep-latest read", async () => {
    for (const bad of [1e21, Number.MAX_SAFE_INTEGER, 1_000_001, NaN, Infinity, 1.5]) {
      const cb = vi.fn();
      await handleMirrorSnapshot(deps, socket({ role: "owner" }), { data: "ct", fileKeyEpoch: bad } as any, cb);
      expect(cb).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    }
    expect(deps.mongodbStore.upsertMirrorSnapshot).not.toHaveBeenCalled();
  });

  it("persists for an admitted GP editor", async () => {
    const cb = vi.fn();
    await handleMirrorSnapshot(deps, socket({ role: "editor", rail: "gp" }), { data: "ct", fileKeyEpoch: 2 } as any, cb);
    expect(deps.mongodbStore.upsertMirrorSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: "doc-1", data: "ct", fileKeyEpoch: 2, sessionDid: "sess-1", createdAt: expect.any(Number) })
    );
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ status: true }));
  });

  it("persists for the owner", async () => {
    const cb = vi.fn();
    await handleMirrorSnapshot(deps, socket({ role: "owner" }), { data: "ct", fileKeyEpoch: 2 } as any, cb);
    expect(deps.mongodbStore.upsertMirrorSnapshot).toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ status: true }));
  });
});
