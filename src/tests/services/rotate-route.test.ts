import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRotateSessionHandler } from "../../services/rotate-route";
import { getRoomName } from "../../services/socket-handlers";

function res() {
  const r: any = {};
  r.status = vi.fn(() => r);
  r.json = vi.fn(() => r);
  return r;
}

describe("POST /documents/:id/rotate-session", () => {
  const documentId = "doc-1";
  const oldSessionDid = "s-old";
  const newSessionDid = "s-new";
  const oldRoom = getRoomName(documentId, oldSessionDid);

  let deps: any, io: any, ownerSock: any, editorSockA: any, editorSockB: any;

  beforeEach(() => {
    vi.clearAllMocks();
    ownerSock = { id: "sock-owner", data: { role: "owner" } };
    editorSockA = { id: "sock-a", data: { role: "editor", rail: "public" } };
    editorSockB = { id: "sock-b", data: { role: "editor", rail: "workspace" } };

    deps = {
      authService: { verifyOwnerOp: vi.fn() },
      sessionManager: {
        getSession: vi.fn(),
        createSession: vi.fn(),
      },
      mongodbStore: { setMinEditEpoch: vi.fn() },
      rotationCoordinator: {
        isActive: vi.fn().mockReturnValue(false),
        begin: vi.fn(),
      },
      terminateOldSession: vi.fn().mockResolvedValue(undefined),
    };

    io = {
      to: vi.fn(() => ({ emit: vi.fn() })),
      in: vi.fn(() => ({
        fetchSockets: vi.fn().mockResolvedValue([ownerSock, editorSockA, editorSockB]),
      })),
    };
  });

  function body(overrides: Record<string, any> = {}) {
    return {
      oldSessionDid,
      newSessionDid,
      payload: "opaque-ct",
      gateEpoch: 5,
      identityToken: "it",
      identityContractAddress: "0xI",
      ownerToken: "ot",
      ownerAddress: "0xO",
      portalAddress: "0xP",
      ...overrides,
    };
  }

  it("403s when verifyOwnerOp rejects", async () => {
    deps.sessionManager.getSession.mockResolvedValue({
      sessionDid: oldSessionDid, ownerDid: "od", ownerIdentityDid: "oid",
    });
    deps.authService.verifyOwnerOp.mockResolvedValue(false);
    const r = res();

    await createRotateSessionHandler(deps, io)(
      { params: { documentId }, body: body() } as any, r
    );

    expect(r.status).toHaveBeenCalledWith(403);
    expect(deps.sessionManager.createSession).not.toHaveBeenCalled();
  });

  it("409s when a rotation is already active for the doc — no broadcast or createSession", async () => {
    deps.rotationCoordinator.isActive.mockReturnValue(true);
    const r = res();

    await createRotateSessionHandler(deps, io)(
      { params: { documentId }, body: body() } as any, r
    );

    expect(r.status).toHaveBeenCalledWith(409);
    expect(deps.sessionManager.getSession).not.toHaveBeenCalled();
    expect(deps.sessionManager.createSession).not.toHaveBeenCalled();
    expect(io.to).not.toHaveBeenCalled();
    expect(deps.rotationCoordinator.begin).not.toHaveBeenCalled();
  });

  it("404s when the old session is not found", async () => {
    deps.sessionManager.getSession.mockResolvedValue(undefined);
    const r = res();

    await createRotateSessionHandler(deps, io)(
      { params: { documentId }, body: body() } as any, r
    );

    expect(r.status).toHaveBeenCalledWith(404);
    expect(deps.authService.verifyOwnerOp).not.toHaveBeenCalled();
  });

  it("400s when required fields are missing", async () => {
    const r = res();

    await createRotateSessionHandler(deps, io)(
      { params: { documentId }, body: { oldSessionDid } } as any, r
    );

    expect(r.status).toHaveBeenCalledWith(400);
    expect(deps.sessionManager.getSession).not.toHaveBeenCalled();
  });

  it("400s when oldSessionDid is missing", async () => {
    const r = res();

    await createRotateSessionHandler(deps, io)(
      { params: { documentId }, body: body({ oldSessionDid: undefined }) } as any, r
    );

    expect(r.status).toHaveBeenCalledWith(400);
    expect(deps.sessionManager.getSession).not.toHaveBeenCalled();
  });

  it.each([NaN, -1, 1.5])("400s when gateEpoch is invalid (%s)", async (badEpoch) => {
    const r = res();

    await createRotateSessionHandler(deps, io)(
      { params: { documentId }, body: body({ gateEpoch: badEpoch }) } as any, r
    );

    expect(r.status).toHaveBeenCalledWith(400);
    expect(deps.sessionManager.getSession).not.toHaveBeenCalled();
  });

  it("on success: creates the new session, stamps minEditEpoch, broadcasts epoch_available, begins the barrier with non-owner sockets, and responds 200", async () => {
    deps.sessionManager.getSession.mockImplementation((docId: string, sessionDid: string) => {
      if (sessionDid === oldSessionDid) {
        return Promise.resolve({
          documentId: docId,
          sessionDid: oldSessionDid,
          ownerDid: "od",
          ownerIdentityDid: "oid",
          portalAddress: "0xPortal",
          collabJoinEnabled: true,
          roomInfo: "room-info-blob",
          appType: "ddoc",
        });
      }
      return Promise.resolve(undefined); // newSessionDid not created yet
    });
    deps.authService.verifyOwnerOp.mockResolvedValue(true);
    const emitSpy = vi.fn();
    io.to = vi.fn(() => ({ emit: emitSpy }));
    const r = res();

    await createRotateSessionHandler(deps, io)(
      { params: { documentId }, body: body() } as any, r
    );

    expect(deps.sessionManager.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId,
        sessionDid: newSessionDid,
        ownerDid: "od",
        ownerIdentityDid: "oid",
        portalAddress: "0xPortal",
        collabJoinEnabled: true,
        roomInfo: "room-info-blob",
        appType: "ddoc",
      })
    );

    expect(deps.mongodbStore.setMinEditEpoch).toHaveBeenCalledWith(documentId, 5);

    expect(io.to).toHaveBeenCalledWith(oldRoom);
    expect(emitSpy).toHaveBeenCalledWith("/session/epoch_available", {
      roomId: documentId,
      epoch: 5,
      payload: "opaque-ct",
    });

    expect(deps.rotationCoordinator.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId,
        oldSessionDid,
        epoch: 5,
        expected: ["sock-a", "sock-b"],
      })
    );

    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.json).toHaveBeenCalledWith({ ok: true, newSessionDid, liveEditors: 2 });
  });

  it("excludes a role-capped socket with no rail (e.g. the owner's headless joinOnly read) from expected/liveEditors", async () => {
    deps.sessionManager.getSession.mockImplementation((docId: string, sessionDid: string) => {
      if (sessionDid === oldSessionDid) {
        return Promise.resolve({
          documentId: docId, sessionDid: oldSessionDid, ownerDid: "od", ownerIdentityDid: "oid", appType: "ddoc",
        });
      }
      return Promise.resolve(undefined);
    });
    deps.authService.verifyOwnerOp.mockResolvedValue(true);
    const railessSock: any = { id: "sock-railess", data: { role: "editor" } }; // no rail — not an admitted editor
    io.in = vi.fn(() => ({
      fetchSockets: vi.fn().mockResolvedValue([ownerSock, editorSockA, railessSock]),
    }));
    io.to = vi.fn(() => ({ emit: vi.fn() }));
    const r = res();

    await createRotateSessionHandler(deps, io)(
      { params: { documentId }, body: body() } as any, r
    );

    expect(deps.rotationCoordinator.begin).toHaveBeenCalledWith(
      expect.objectContaining({ expected: ["sock-a"] })
    );
    expect(r.json).toHaveBeenCalledWith({ ok: true, newSessionDid, liveEditors: 1 });
  });

  it("does not recreate the new session row if it already exists (idempotent on retry)", async () => {
    deps.sessionManager.getSession.mockImplementation((docId: string, sessionDid: string) => {
      if (sessionDid === oldSessionDid) {
        return Promise.resolve({
          documentId: docId, sessionDid: oldSessionDid, ownerDid: "od", ownerIdentityDid: "oid",
        });
      }
      return Promise.resolve({ documentId: docId, sessionDid: newSessionDid, ownerDid: "od" });
    });
    deps.authService.verifyOwnerOp.mockResolvedValue(true);
    const r = res();

    await createRotateSessionHandler(deps, io)(
      { params: { documentId }, body: body() } as any, r
    );

    expect(deps.sessionManager.createSession).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it("onCutover broadcasts /session/cutover then schedules terminateOldSession after the drain window", async () => {
    vi.useFakeTimers();
    try {
      deps.sessionManager.getSession.mockImplementation((docId: string, sessionDid: string) => {
        if (sessionDid === oldSessionDid) {
          return Promise.resolve({
            documentId: docId, sessionDid: oldSessionDid, ownerDid: "od", ownerIdentityDid: "oid", appType: "ddoc",
          });
        }
        return Promise.resolve(undefined);
      });
      deps.authService.verifyOwnerOp.mockResolvedValue(true);
      const emitSpy = vi.fn();
      io.to = vi.fn(() => ({ emit: emitSpy }));
      const r = res();

      await createRotateSessionHandler(deps, io)(
        { params: { documentId }, body: body() } as any, r
      );

      const onCutover = deps.rotationCoordinator.begin.mock.calls[0][0].onCutover;
      expect(deps.terminateOldSession).not.toHaveBeenCalled();

      onCutover();

      expect(emitSpy).toHaveBeenCalledWith("/session/cutover", { roomId: documentId, epoch: 5 });
      expect(deps.terminateOldSession).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10_000);

      expect(deps.terminateOldSession).toHaveBeenCalledWith(documentId, oldSessionDid, "ddoc");
    } finally {
      vi.useRealTimers();
    }
  });
});
