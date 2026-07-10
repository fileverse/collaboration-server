import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFlushHandler, FLUSH_MAX_BYTES } from "../../services/flush-route";

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
      authService: { verifyCollaborationToken: vi.fn() },
      mongodbStore: { createUpdate: vi.fn().mockResolvedValue({ id: "u1", seq: 5 }) },
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
});
