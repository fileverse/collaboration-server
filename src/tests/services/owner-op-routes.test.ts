import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCollabJoinEnabledHandler, createListMyDocumentsHandler, createDeleteDocumentHandler, createWorkspaceEditTierHandler } from "../../services/owner-op-routes";
import { createRefreshEditGrantHandler, createMirrorReadHandler } from "../../services/owner-op-routes";
import { getRoomName } from "../../services/socket-handlers";

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
      sessionManager: {
        getSession: vi.fn(),
        setCollabJoinEnabled: vi.fn(),
        getNonTerminatedSessionsForDocument: vi.fn().mockResolvedValue([]),
      },
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

  it("closes the flag + drops sockets across ALL non-terminated sessions, not just the client's", async () => {
    deps.sessionManager.getSession.mockResolvedValue({ sessionDid: "s-stale", ownerDid: "od", ownerIdentityDid: "oid" });
    deps.authService.verifyOwnerOp.mockResolvedValue(true);
    deps.sessionManager.getNonTerminatedSessionsForDocument.mockResolvedValue([
      { sessionDid: "s-cur" },
      { sessionDid: "s-old" },
    ]);
    const editorSock: any = { data: { role: "editor" }, disconnect: vi.fn() };
    io.in = vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([editorSock]) }));
    const r = res();

    await createCollabJoinEnabledHandler(deps, io)(
      { params: { documentId: "doc-1" }, body: { sessionDid: "s-stale", enabled: false } } as any, r
    );

    // Every session — the current one, the old one, and the caller's own stale one — is closed.
    for (const sd of ["s-cur", "s-old", "s-stale"]) {
      expect(deps.sessionManager.setCollabJoinEnabled).toHaveBeenCalledWith("doc-1", sd, false);
      expect(io.in).toHaveBeenCalledWith(`session::doc-1__${sd}`);
    }
    expect(editorSock.disconnect).toHaveBeenCalledTimes(3);
    expect(r.status).toHaveBeenCalledWith(200);
  });
});

describe("POST workspace-edit-tier", () => {
  let deps: any, io: any;
  beforeEach(() => {
    vi.clearAllMocks();
    deps = {
      authService: { verifyOwnerOp: vi.fn() },
      sessionManager: {
        getSession: vi.fn(),
        setWorkspaceEditEnabled: vi.fn(),
        getNonTerminatedSessionsForDocument: vi.fn().mockResolvedValue([]),
      },
    };
    io = { in: vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([]) })) };
  });

  it("403s when verifyOwnerOp rejects", async () => {
    deps.sessionManager.getSession.mockResolvedValue({ sessionDid: "s", ownerDid: "od", ownerIdentityDid: "oid" });
    deps.authService.verifyOwnerOp.mockResolvedValue(false);
    const r = res();
    await createWorkspaceEditTierHandler(deps, io)(
      { params: { documentId: "doc-1" }, body: { sessionDid: "s", enabled: true } } as any, r
    );
    expect(r.status).toHaveBeenCalledWith(403);
    expect(deps.sessionManager.setWorkspaceEditEnabled).not.toHaveBeenCalled();
  });

  it("enables the tier for the proven owner", async () => {
    deps.sessionManager.getSession.mockResolvedValue({ sessionDid: "s", ownerDid: "od", ownerIdentityDid: "oid" });
    deps.authService.verifyOwnerOp.mockResolvedValue(true);
    deps.sessionManager.getNonTerminatedSessionsForDocument.mockResolvedValue([{ sessionDid: "s" }]);
    const r = res();
    await createWorkspaceEditTierHandler(deps, io)(
      { params: { documentId: "doc-1" }, body: { sessionDid: "s", enabled: true } } as any, r
    );
    expect(deps.sessionManager.setWorkspaceEditEnabled).toHaveBeenCalledWith("doc-1", "s", true);
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it("on disable, force-drops ONLY workspace-rail sockets (not public editors or owners)", async () => {
    deps.sessionManager.getSession.mockResolvedValue({ sessionDid: "s", ownerDid: "od", ownerIdentityDid: "oid" });
    deps.authService.verifyOwnerOp.mockResolvedValue(true);
    deps.sessionManager.getNonTerminatedSessionsForDocument.mockResolvedValue([{ sessionDid: "s" }]);
    const wsSock: any = { data: { role: "editor", rail: "workspace" }, disconnect: vi.fn() };
    const pubSock: any = { data: { role: "editor", rail: "public" }, disconnect: vi.fn() };
    const ownerSock: any = { data: { role: "owner" }, disconnect: vi.fn() };
    io.in = vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([wsSock, pubSock, ownerSock]) }));
    const r = res();
    await createWorkspaceEditTierHandler(deps, io)(
      { params: { documentId: "doc-1" }, body: { sessionDid: "s", enabled: false } } as any, r
    );
    expect(wsSock.disconnect).toHaveBeenCalledWith(true);
    expect(pubSock.disconnect).not.toHaveBeenCalled();
    expect(ownerSock.disconnect).not.toHaveBeenCalled();
  });

  it("writes the flag to every non-terminated session plus the request one (doc-wide)", async () => {
    deps.sessionManager.getSession.mockResolvedValue({ sessionDid: "s-req", ownerDid: "od", ownerIdentityDid: "oid" });
    deps.authService.verifyOwnerOp.mockResolvedValue(true);
    deps.sessionManager.getNonTerminatedSessionsForDocument.mockResolvedValue([{ sessionDid: "s-a" }, { sessionDid: "s-b" }]);
    const r = res();
    await createWorkspaceEditTierHandler(deps, io)(
      { params: { documentId: "doc-1" }, body: { sessionDid: "s-req", enabled: true } } as any, r
    );
    expect(deps.sessionManager.setWorkspaceEditEnabled).toHaveBeenCalledWith("doc-1", "s-a", true);
    expect(deps.sessionManager.setWorkspaceEditEnabled).toHaveBeenCalledWith("doc-1", "s-b", true);
    expect(deps.sessionManager.setWorkspaceEditEnabled).toHaveBeenCalledWith("doc-1", "s-req", true);
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

describe("POST refresh-edit-grant", () => {
  let deps: any, io: any, gateEpochCache: any;
  beforeEach(() => {
    vi.clearAllMocks();
    gateEpochCache = { refreshEditGrantEpoch: vi.fn() };
    deps = {
      authService: { verifyOwnerOp: vi.fn() },
      sessionManager: {
        getSession: vi.fn().mockResolvedValue({ sessionDid: "s", ownerDid: "od", ownerIdentityDid: "oid" }),
        getNonTerminatedSessionsForDocument: vi.fn().mockResolvedValue([{ sessionDid: "s" }]),
      },
      gateEpochCache,
    };
    io = { in: vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([]) })) };
  });

  it("403s when verifyOwnerOp rejects (and never touches the gate)", async () => {
    deps.authService.verifyOwnerOp.mockResolvedValue(false);
    const r = res();
    await createRefreshEditGrantHandler(deps, io)(
      { params: { documentId: "doc-1" }, body: { sessionDid: "s" } } as any, r
    );
    expect(r.status).toHaveBeenCalledWith(403);
    expect(gateEpochCache.refreshEditGrantEpoch).not.toHaveBeenCalled();
  });

  it("404s when the session is unknown", async () => {
    deps.sessionManager.getSession.mockResolvedValue(null);
    const r = res();
    await createRefreshEditGrantHandler(deps, io)(
      { params: { documentId: "doc-1" }, body: { sessionDid: "s" } } as any, r
    );
    expect(r.status).toHaveBeenCalledWith(404);
    expect(gateEpochCache.refreshEditGrantEpoch).not.toHaveBeenCalled();
  });

  it("refreshes the epoch and force-drops ONLY stale GP sockets (not fresh GP / workspace / owner)", async () => {
    deps.authService.verifyOwnerOp.mockResolvedValue(true);
    gateEpochCache.refreshEditGrantEpoch.mockResolvedValue(6);
    const staleGp: any = { data: { role: "editor", rail: "gp", admittedEditGrantEpoch: 5 }, disconnect: vi.fn() };
    const freshGp: any = { data: { role: "editor", rail: "gp", admittedEditGrantEpoch: 6 }, disconnect: vi.fn() };
    const ws: any = { data: { role: "editor", rail: "workspace", admittedEditGrantEpoch: 0 }, disconnect: vi.fn() };
    const owner: any = { data: { role: "owner" }, disconnect: vi.fn() };
    io.in = vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([staleGp, freshGp, ws, owner]) }));
    const r = res();
    await createRefreshEditGrantHandler(deps, io)(
      { params: { documentId: "doc-1" }, body: { sessionDid: "s" } } as any, r
    );
    expect(gateEpochCache.refreshEditGrantEpoch).toHaveBeenCalledWith("doc-1");
    expect(staleGp.disconnect).toHaveBeenCalledWith(true);
    expect(freshGp.disconnect).not.toHaveBeenCalled();
    expect(ws.disconnect).not.toHaveBeenCalled();
    expect(owner.disconnect).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.json).toHaveBeenCalledWith({ ok: true, editGrantEpoch: 6 });
  });

  it("sweeps EVERY non-terminated session room plus the caller's own (doc-wide)", async () => {
    deps.authService.verifyOwnerOp.mockResolvedValue(true);
    gateEpochCache.refreshEditGrantEpoch.mockResolvedValue(6);
    deps.sessionManager.getNonTerminatedSessionsForDocument.mockResolvedValue([
      { sessionDid: "s-a" },
      { sessionDid: "s-b" },
    ]);
    const gpA: any = { data: { role: "editor", rail: "gp", admittedEditGrantEpoch: 5 }, disconnect: vi.fn() };
    const gpCaller: any = { data: { role: "editor", rail: "gp", admittedEditGrantEpoch: 5 }, disconnect: vi.fn() };
    const byRoom: Record<string, any[]> = {
      [getRoomName("doc-1", "s-a")]: [gpA],
      [getRoomName("doc-1", "s-b")]: [],
      [getRoomName("doc-1", "s-c")]: [gpCaller], // caller's sessionDid, NOT in the non-terminated list
    };
    io.in = vi.fn((room: string) => ({ fetchSockets: vi.fn().mockResolvedValue(byRoom[room] ?? []) }));
    const r = res();
    await createRefreshEditGrantHandler(deps, io)(
      { params: { documentId: "doc-1" }, body: { sessionDid: "s-c" } } as any, r
    );
    expect(gpA.disconnect).toHaveBeenCalledWith(true); // a listed session's room was swept
    expect(gpCaller.disconnect).toHaveBeenCalledWith(true); // the caller's own room was swept too
    expect(io.in).toHaveBeenCalledWith(getRoomName("doc-1", "s-a"));
    expect(io.in).toHaveBeenCalledWith(getRoomName("doc-1", "s-c"));
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it("does NOT force-drop when the gate epoch is unavailable (null) — the chokepoint backstop covers it", async () => {
    deps.authService.verifyOwnerOp.mockResolvedValue(true);
    gateEpochCache.refreshEditGrantEpoch.mockResolvedValue(null);
    const gp: any = { data: { role: "editor", rail: "gp", admittedEditGrantEpoch: 5 }, disconnect: vi.fn() };
    io.in = vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([gp]) }));
    const r = res();
    await createRefreshEditGrantHandler(deps, io)(
      { params: { documentId: "doc-1" }, body: { sessionDid: "s" } } as any, r
    );
    expect(gp.disconnect).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.json).toHaveBeenCalledWith({ ok: true, editGrantEpoch: null });
  });
});

describe("GET /documents/:id/mirror", () => {
  it("returns the latest mirror snapshot", async () => {
    const deps: any = { mongodbStore: { getLatestMirror: vi.fn().mockResolvedValue({ data: "ct", fileKeyEpoch: 3, createdAt: 9 }) } };
    const r = res();
    await createMirrorReadHandler(deps)({ params: { documentId: "doc-1" } } as any, r);
    expect(deps.mongodbStore.getLatestMirror).toHaveBeenCalledWith("doc-1");
    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.json).toHaveBeenCalledWith({ data: "ct", fileKeyEpoch: 3, createdAt: 9 });
  });

  it("404s when there is no mirror yet", async () => {
    const deps: any = { mongodbStore: { getLatestMirror: vi.fn().mockResolvedValue(null) } };
    const r = res();
    await createMirrorReadHandler(deps)({ params: { documentId: "doc-1" } } as any, r);
    expect(r.status).toHaveBeenCalledWith(404);
  });
});
