import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFlushHandler, FLUSH_MAX_BYTES } from "../../services/flush-route";
import { SessionTerminatedError } from "../../services/mongodb-store";

function res() {
  const r: any = {};
  r.status = vi.fn(() => r);
  r.json = vi.fn(() => r);
  return r;
}

describe("POST /flush", () => {
  let deps: any;
  beforeEach(() => {
    vi.clearAllMocks();
    deps = {
      authService: { verifyCollaborationToken: vi.fn(), verifyEditUcan: vi.fn() },
      mongodbStore: {
        createUpdate: vi.fn().mockResolvedValue({ id: "u1", seq: 5 }),
        getMinEditEpoch: vi.fn().mockResolvedValue(0),
      },
    };
  });

  it("401s on an invalid collaboration token", async () => {
    deps.authService.verifyCollaborationToken.mockResolvedValue(false);
    const r = res();
    await createFlushHandler(deps)({ body: { documentId: "d", sessionDid: "s", collaborationToken: "t", data: "ct" } } as any, r);
    expect(r.status).toHaveBeenCalledWith(401);
    expect(deps.mongodbStore.createUpdate).not.toHaveBeenCalled();
  });

  it("413s when the payload exceeds the size cap", async () => {
    deps.authService.verifyCollaborationToken.mockResolvedValue(true);
    const r = res();
    await createFlushHandler(deps)({ body: { documentId: "d", sessionDid: "s", collaborationToken: "t", data: "x".repeat(FLUSH_MAX_BYTES + 1) } } as any, r);
    expect(r.status).toHaveBeenCalledWith(413);
    expect(deps.mongodbStore.createUpdate).not.toHaveBeenCalled();
  });

  // No editUcan on the body (public/workspace/owner rails) → the belt is skipped and the delta
  // persists as before. Regression guard: the belt must not gate rails that never carry a claim.
  it("persists a verified delta through createUpdate (seq + durable gate apply there)", async () => {
    deps.authService.verifyCollaborationToken.mockResolvedValue(true);
    const r = res();
    await createFlushHandler(deps)({ body: { documentId: "d", sessionDid: "s", collaborationToken: "t", data: "ct" } } as any, r);
    expect(deps.authService.verifyCollaborationToken).toHaveBeenCalledWith("t", "s", "d");
    expect(deps.mongodbStore.createUpdate).toHaveBeenCalledWith(expect.objectContaining({
      documentId: "d", data: "ct", updateType: "yjs_update", sessionDid: "s", appType: "ddoc",
    }));
    expect(r.status).toHaveBeenCalledWith(200);
  });

  // H3(a) belt: when the beacon carries a gp-actor editUcan, the durable-write path re-runs the
  // same offline admission JOIN does — a revoked/demoted claim (below the floor, or no longer an
  // actor claim) is refused here too, covering the rotation-deferred / pre-cutover window.
  it("403s a gp-actor editUcan whose epoch is below the doc's minEditEpoch floor", async () => {
    deps.authService.verifyCollaborationToken.mockResolvedValue(true);
    deps.authService.verifyEditUcan.mockResolvedValue({ kind: "actor", editHandle: "h1", epoch: 1 });
    deps.mongodbStore.getMinEditEpoch.mockResolvedValue(2); // a rotation advanced the floor past the claim
    const r = res();
    await createFlushHandler(deps)({ body: { documentId: "d", sessionDid: "s", collaborationToken: "t", data: "ct", editUcan: "revoked" } } as any, r);
    expect(r.status).toHaveBeenCalledWith(403);
    expect(deps.mongodbStore.createUpdate).not.toHaveBeenCalled();
  });

  it("403s an editUcan that no longer verifies as an actor claim", async () => {
    deps.authService.verifyCollaborationToken.mockResolvedValue(true);
    deps.authService.verifyEditUcan.mockResolvedValue(null);
    const r = res();
    await createFlushHandler(deps)({ body: { documentId: "d", sessionDid: "s", collaborationToken: "t", data: "ct", editUcan: "bad" } } as any, r);
    expect(r.status).toHaveBeenCalledWith(403);
    expect(deps.mongodbStore.createUpdate).not.toHaveBeenCalled();
  });

  it("persists a delta when the editUcan is at/above the floor", async () => {
    deps.authService.verifyCollaborationToken.mockResolvedValue(true);
    deps.authService.verifyEditUcan.mockResolvedValue({ kind: "actor", editHandle: "h1", epoch: 3 });
    deps.mongodbStore.getMinEditEpoch.mockResolvedValue(2);
    const r = res();
    await createFlushHandler(deps)({ body: { documentId: "d", sessionDid: "s", collaborationToken: "t", data: "ct", editUcan: "good" } } as any, r);
    expect(deps.authService.verifyEditUcan).toHaveBeenCalledWith("good", "d");
    expect(deps.mongodbStore.createUpdate).toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it("409s with an error body (not 200) when createUpdate rejects with SessionTerminatedError", async () => {
    deps.authService.verifyCollaborationToken.mockResolvedValue(true);
    deps.mongodbStore.createUpdate.mockRejectedValue(new SessionTerminatedError());
    const r = res();
    await createFlushHandler(deps)({ body: { documentId: "d", sessionDid: "s", collaborationToken: "t", data: "ct" } } as any, r);

    expect(r.status).toHaveBeenCalledWith(409);
    expect(r.status).not.toHaveBeenCalledWith(200);
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
  });
});
