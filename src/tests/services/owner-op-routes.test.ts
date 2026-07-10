import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCollabJoinEnabledHandler, createListMyDocumentsHandler, createDeleteDocumentHandler } from "../../services/owner-op-routes";

function res() {
  const r: any = {};
  r.status = vi.fn(() => r);
  r.json = vi.fn(() => r);
  return r;
}

describe("POST collab-join-enabled", () => {
  let deps: any, io: any;
  beforeEach(() => {
    vi.clearAllMocks();
    deps = {
      authService: { verifyOwnerOp: vi.fn() },
      sessionManager: { getSession: vi.fn(), setCollabJoinEnabled: vi.fn() },
    };
    io = { in: vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([]) })) };
  });

  it("403s when verifyOwnerOp rejects", async () => {
    deps.sessionManager.getSession.mockResolvedValue({ sessionDid: "s", ownerDid: "od", ownerIdentityDid: "oid" });
    deps.authService.verifyOwnerOp.mockResolvedValue(false);
    const r = res();
    await createCollabJoinEnabledHandler(deps, io)(
      { params: { documentId: "doc-1" }, body: { sessionDid: "s", enabled: true } } as any, r
    );
    expect(r.status).toHaveBeenCalledWith(403);
    expect(deps.sessionManager.setCollabJoinEnabled).not.toHaveBeenCalled();
  });

  it("sets the flag for the two-proof owner and force-drops non-owner sockets on disable", async () => {
    deps.sessionManager.getSession.mockResolvedValue({ sessionDid: "s", ownerDid: "od", ownerIdentityDid: "oid" });
    deps.authService.verifyOwnerOp.mockResolvedValue(true);
    const ownerSock: any = { data: { role: "owner" }, disconnect: vi.fn() };
    const editorSock: any = { data: { role: "editor" }, disconnect: vi.fn() };
    io.in = vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([ownerSock, editorSock]) }));
    const r = res();

    await createCollabJoinEnabledHandler(deps, io)(
      { params: { documentId: "doc-1" }, body: { sessionDid: "s", enabled: false } } as any, r
    );

    expect(deps.sessionManager.setCollabJoinEnabled).toHaveBeenCalledWith("doc-1", "s", false);
    expect(editorSock.disconnect).toHaveBeenCalledWith(true);
    expect(ownerSock.disconnect).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(200);
  });
});

describe("POST /list-my-documents", () => {
  let deps: any;
  beforeEach(() => {
    vi.clearAllMocks();
    deps = {
      authService: { verifyIdentityToken: vi.fn(), verifyOwnerToken: vi.fn() },
      mongodbStore: { listDocumentsForOwner: vi.fn().mockResolvedValue([{ documentId: "d1", editLock: "el", title: "t" }]) },
    };
  });

  it("returns docs bound to the proven identity signingDid", async () => {
    deps.authService.verifyIdentityToken.mockResolvedValue("did:key:zOwner");
    const r = res();
    await createListMyDocumentsHandler(deps)(
      { body: { identityToken: "it", identityContractAddress: "0xI", portalAddress: "0xP" } } as any, r
    );
    expect(deps.mongodbStore.listDocumentsForOwner).toHaveBeenCalledWith({ ownerIdentityDid: "did:key:zOwner" });
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it("401s when the fields are missing (short-circuits before verifyIdentityToken)", async () => {
    deps.authService.verifyIdentityToken.mockResolvedValue(null);
    deps.authService.verifyOwnerToken.mockResolvedValue(null);
    const r = res();
    await createListMyDocumentsHandler(deps)({ body: {} } as any, r);
    expect(r.status).toHaveBeenCalledWith(401);
  });

  it("401s when all fields are present but verifyIdentityToken resolves null (signingDid branch)", async () => {
    deps.authService.verifyIdentityToken.mockResolvedValue(null);
    const r = res();
    await createListMyDocumentsHandler(deps)(
      { body: { identityToken: "it", identityContractAddress: "0xI", portalAddress: "0xP" } } as any, r
    );
    expect(r.status).toHaveBeenCalledWith(401);
    expect(deps.mongodbStore.listDocumentsForOwner).not.toHaveBeenCalled();
  });
});

describe("DELETE /documents/:id", () => {
  let deps: any;
  beforeEach(() => {
    deps = {
      authService: { verifyOwnerOp: vi.fn() },
      sessionManager: { getSession: vi.fn() },
      mongodbStore: { purgeDocument: vi.fn() },
    };
  });

  it("403s when there is no owner-of-record", async () => {
    deps.sessionManager.getSession.mockResolvedValue({ sessionDid: "s", ownerDid: null, ownerIdentityDid: null });
    const r = res();
    await createDeleteDocumentHandler(deps)({ params: { documentId: "d" }, body: { sessionDid: "s" } } as any, r);
    expect(r.status).toHaveBeenCalledWith(403);
    expect(deps.mongodbStore.purgeDocument).not.toHaveBeenCalled();
  });

  it("purges everything for the two-proof owner", async () => {
    deps.sessionManager.getSession.mockResolvedValue({ sessionDid: "s", ownerDid: "od", ownerIdentityDid: "oid" });
    deps.authService.verifyOwnerOp.mockResolvedValue(true);
    const r = res();
    await createDeleteDocumentHandler(deps)({ params: { documentId: "d" }, body: { sessionDid: "s" } } as any, r);
    expect(deps.mongodbStore.purgeDocument).toHaveBeenCalledWith("d");
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it("403s when there IS an owner-of-record but verifyOwnerOp rejects (no crypto proof)", async () => {
    deps.sessionManager.getSession.mockResolvedValue({ sessionDid: "s", ownerDid: "od", ownerIdentityDid: "oid" });
    deps.authService.verifyOwnerOp.mockResolvedValue(false);
    const r = res();
    await createDeleteDocumentHandler(deps)({ params: { documentId: "d" }, body: { sessionDid: "s" } } as any, r);
    expect(r.status).toHaveBeenCalledWith(403);
    expect(deps.mongodbStore.purgeDocument).not.toHaveBeenCalled();
  });

  it("404s when there is no session for the document", async () => {
    deps.sessionManager.getSession.mockResolvedValue(undefined);
    const r = res();
    await createDeleteDocumentHandler(deps)({ params: { documentId: "d" }, body: { sessionDid: "s" } } as any, r);
    expect(r.status).toHaveBeenCalledWith(404);
    expect(deps.mongodbStore.purgeDocument).not.toHaveBeenCalled();
  });
});
