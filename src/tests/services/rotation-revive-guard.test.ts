import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleAuth } from "../../services/socket-handlers";
import { createRotateSessionHandler } from "../../services/rotate-route";
import {
  createRotationRecordHandler,
  createShareContextHandler,
} from "../../services/owner-op-routes";
import { AppServer, AppSocket, AuthArgs, ErrorCode } from "../../types";
import type { SocketHandlerDeps } from "../../services/socket-handlers.deps";

function res() {
  const r: any = {};
  r.status = vi.fn(() => r);
  r.json = vi.fn(() => r);
  return r;
}

const fakeIO = (): AppServer =>
  ({
    to: vi.fn(() => ({ emit: vi.fn() })),
    in: vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([]) })),
  }) as unknown as AppServer;

const fakeSocket = (): AppSocket =>
  ({
    id: "socket-1",
    data: { authenticated: false, documentId: "", sessionDid: "", role: "editor" },
    to: vi.fn(() => ({ emit: vi.fn() })),
    join: vi.fn(),
  }) as unknown as AppSocket;

const record = {
  rotatedTo: "s-new",
  epoch: 4,
  payload: "opaque-ct",
  ownerDid: "did:key:portal",
  ownerIdentityDid: "did:key:creator",
};

describe("rotate-session records the rotation on the old session", () => {
  it("writes rotatedTo, epoch and the relayed payload before broadcasting", async () => {
    const order: string[] = [];
    const deps: any = {
      authService: { verifyOwnerOp: vi.fn().mockResolvedValue(true) },
      sessionManager: {
        getSession: vi.fn(async (_d: string, sd: string) =>
          sd === "s-old"
            ? { sessionDid: "s-old", ownerDid: "od", ownerIdentityDid: "oid", appType: "ddoc" }
            : undefined
        ),
        createSession: vi.fn(),
        markRotated: vi.fn(async () => {
          order.push("markRotated");
        }),
      },
      mongodbStore: { setMinEditEpoch: vi.fn() },
      rotationCoordinator: { isActive: vi.fn().mockReturnValue(false), begin: vi.fn() },
      terminateOldSession: vi.fn(),
    };
    const io: any = {
      to: vi.fn(() => ({ emit: vi.fn(() => order.push("emit")) })),
      in: vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([]) })),
    };
    const r = res();

    await createRotateSessionHandler(deps, io)(
      {
        params: { documentId: "doc-1" },
        body: {
          oldSessionDid: "s-old",
          newSessionDid: "s-new",
          payload: "opaque-ct",
          gateEpoch: 4,
          identityToken: "it",
        },
      } as any,
      r
    );

    expect(deps.sessionManager.markRotated).toHaveBeenCalledWith("doc-1", "s-old", {
      rotatedTo: "s-new",
      epoch: 4,
      payload: "opaque-ct",
    });
    expect(order[0]).toBe("markRotated");
    expect(r.status).toHaveBeenCalledWith(200);
  });
});

describe("owner /auth never revives a rotated-away session", () => {
  const authService = {
    verifyOwnerToken: vi.fn(),
    verifyCollaborationToken: vi.fn(),
    verifyIdentityToken: vi.fn(),
    verifyEditUcan: vi.fn(),
    getServerDid: vi.fn(),
  };
  const sessionManager = {
    getSession: vi.fn(),
    getSessionIncludingTerminated: vi.fn(),
    getRotation: vi.fn(),
    getOtherNonTerminatedSessions: vi.fn().mockResolvedValue([]),
    terminateSession: vi.fn(),
    createSession: vi.fn(),
    updateRoomInfo: vi.fn(),
    addClientToSession: vi.fn(),
    getCollabJoinEnabled: vi.fn(),
    getWorkspaceEditEnabled: vi.fn(),
    fillOwnerIdentityDidIfAbsent: vi.fn(),
    updateSessionOwnerDid: vi.fn(),
  };
  const mongodbStore = {
    getDocumentMeta: vi.fn().mockResolvedValue(null),
    getMinEditEpoch: vi.fn().mockResolvedValue(0),
    pinDocumentPortalIfAbsent: vi.fn(async (p: { portalAddress: string }) => ({
      portalAddress: p.portalAddress,
    })),
    getWireFormat: vi.fn().mockResolvedValue("ecies"),
    lockWireFormat: vi.fn().mockResolvedValue(false),
  } as any;
  const deps: SocketHandlerDeps = {
    authService: authService as any,
    sessionManager: sessionManager as any,
    mongodbStore,
  };
  const ownerArgs: AuthArgs = {
    documentId: "doc-1",
    sessionDid: "s-old",
    collaborationToken: "collab-token",
    ownerToken: "owner-token",
    ownerAddress: "0x0000000000000000000000000000000000000001",
    contractAddress: "0x0000000000000000000000000000000000000002",
    identityToken: "identity-token",
  };
  const liveOldRow = {
    documentId: "doc-1",
    sessionDid: "s-old",
    ownerDid: "did:key:portal",
    ownerIdentityDid: "did:key:creator",
    appType: "ddoc",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    sessionManager.getOtherNonTerminatedSessions.mockResolvedValue([]);
    authService.verifyOwnerToken.mockResolvedValue("did:key:portal");
    authService.verifyIdentityToken.mockResolvedValue("did:key:creator");
    authService.verifyCollaborationToken.mockResolvedValue("did:key:collab");
  });

  it("refuses the create path for a terminated, rotated session: no pin, no sweep, no upsert", async () => {
    sessionManager.getSession.mockResolvedValue(undefined);
    sessionManager.getRotation.mockResolvedValue(record);
    const socket = fakeSocket();
    const callback = vi.fn();

    await handleAuth(deps, fakeIO(), socket, { ...ownerArgs }, callback);

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        status: false,
        statusCode: 404,
        errorCode: ErrorCode.SESSION_ROTATED,
      })
    );
    expect(mongodbStore.pinDocumentPortalIfAbsent).not.toHaveBeenCalled();
    expect(sessionManager.getOtherNonTerminatedSessions).not.toHaveBeenCalled();
    expect(sessionManager.terminateSession).not.toHaveBeenCalled();
    expect(sessionManager.createSession).not.toHaveBeenCalled();
    expect(socket.join).not.toHaveBeenCalled();
  });

  it("still creates (revives) a terminated session that was NOT rotated, as before", async () => {
    sessionManager.getSession.mockResolvedValue(undefined);
    sessionManager.getRotation.mockResolvedValue(undefined);
    const callback = vi.fn();

    await handleAuth(deps, fakeIO(), fakeSocket(), { ...ownerArgs }, callback);

    expect(sessionManager.createSession).toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        status: true,
        data: expect.objectContaining({ sessionType: "new" }),
      })
    );
  });

  it("refuses an owner joining the old session while it drains", async () => {
    sessionManager.getSession.mockResolvedValue({ ...liveOldRow });
    sessionManager.getRotation.mockResolvedValue(record);
    const socket = fakeSocket();
    const callback = vi.fn();

    await handleAuth(deps, fakeIO(), socket, { ...ownerArgs }, callback);

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        status: false,
        statusCode: 404,
        errorCode: ErrorCode.SESSION_ROTATED,
      })
    );
    expect(socket.join).not.toHaveBeenCalled();
    expect(sessionManager.updateRoomInfo).not.toHaveBeenCalled();
  });

  it("lets an editor keep draining in the old session", async () => {
    sessionManager.getSession.mockResolvedValue({ ...liveOldRow });
    sessionManager.getRotation.mockResolvedValue(record);
    sessionManager.getCollabJoinEnabled.mockResolvedValue(true);
    const callback = vi.fn();

    await handleAuth(
      deps,
      fakeIO(),
      fakeSocket(),
      { documentId: "doc-1", sessionDid: "s-old", collaborationToken: "collab-token" },
      callback
    );

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ status: true, data: expect.objectContaining({ role: "editor" }) })
    );
  });

  it("keeps the owner's read-only joinOnly read of a rotated, terminated session", async () => {
    sessionManager.getSession.mockResolvedValue(undefined);
    sessionManager.getSessionIncludingTerminated.mockResolvedValue({ ...liveOldRow });
    sessionManager.getRotation.mockResolvedValue(record);
    const callback = vi.fn();

    await handleAuth(deps, fakeIO(), fakeSocket(), { ...ownerArgs, joinOnly: true }, callback);

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ status: true, data: expect.objectContaining({ role: "editor" }) })
    );
    expect(sessionManager.createSession).not.toHaveBeenCalled();
  });
});

describe("POST /documents/:id/rotation", () => {
  const mk = (rotation: typeof record | undefined, authorized: boolean) => ({
    authService: { verifyOwnerOp: vi.fn().mockResolvedValue(authorized) },
    sessionManager: { getRotation: vi.fn().mockResolvedValue(rotation) },
  });

  it("400s without a sessionDid", async () => {
    const deps = mk(record, true);
    const r = res();
    await createRotationRecordHandler(deps as any)(
      { params: { documentId: "doc-1" }, body: {} } as any,
      r
    );
    expect(r.status).toHaveBeenCalledWith(400);
    expect(deps.sessionManager.getRotation).not.toHaveBeenCalled();
  });

  it("404s when the session was not rotated", async () => {
    const deps = mk(undefined, true);
    const r = res();
    await createRotationRecordHandler(deps as any)(
      {
        params: { documentId: "doc-1" },
        body: { sessionDid: "s-old", identityToken: "it" },
      } as any,
      r
    );
    expect(r.status).toHaveBeenCalledWith(404);
    expect(deps.authService.verifyOwnerOp).not.toHaveBeenCalled();
  });

  it("403s a caller that is not the bound owner", async () => {
    const deps = mk(record, false);
    const r = res();
    await createRotationRecordHandler(deps as any)(
      {
        params: { documentId: "doc-1" },
        body: { sessionDid: "s-old", identityToken: "it" },
      } as any,
      r
    );
    expect(deps.authService.verifyOwnerOp).toHaveBeenCalledWith({
      ddocId: "doc-1",
      boundOwnerIdentityDid: "did:key:creator",
      boundOwnerDid: "did:key:portal",
      identityToken: "it",
    });
    expect(r.status).toHaveBeenCalledWith(403);
    expect(r.json).not.toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.anything() })
    );
  });

  it("returns the successor, epoch and payload to the owner", async () => {
    const deps = mk(record, true);
    const r = res();
    await createRotationRecordHandler(deps as any)(
      {
        params: { documentId: "doc-1" },
        body: { sessionDid: "s-old", identityToken: "it" },
      } as any,
      r
    );
    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.json).toHaveBeenCalledWith({ rotatedTo: "s-new", epoch: 4, payload: "opaque-ct" });
  });
});

describe("share-context rotated flag", () => {
  it("reports rotated: true for a rotated session and nothing else about it", async () => {
    const shareDeps: any = {
      mongodbStore: {
        getShareContext: vi.fn().mockResolvedValue({ exists: true, isPublished: true }),
      },
      sessionManager: {
        getSession: vi.fn().mockResolvedValue(undefined),
        getLegacyRtcVerdict: vi.fn(),
        getRotation: vi.fn().mockResolvedValue(record),
      },
    };
    const r = res();
    await createShareContextHandler(shareDeps)(
      { params: { documentId: "doc-1" }, query: { sessionDid: "s-old" } } as any,
      r
    );
    expect(r.json).toHaveBeenCalledWith({
      exists: true,
      isPublished: true,
      sessionExists: false,
      rotated: true,
    });
  });

  it("omits the flag for a session that was not rotated", async () => {
    const shareDeps: any = {
      mongodbStore: {
        getShareContext: vi.fn().mockResolvedValue({ exists: true, isPublished: true }),
      },
      sessionManager: {
        getSession: vi.fn().mockResolvedValue({ sessionDid: "s-new" }),
        getLegacyRtcVerdict: vi.fn().mockResolvedValue(undefined),
        getRotation: vi.fn().mockResolvedValue(undefined),
      },
    };
    const r = res();
    await createShareContextHandler(shareDeps)(
      { params: { documentId: "doc-1" }, query: { sessionDid: "s-new" } } as any,
      r
    );
    expect(r.json).toHaveBeenCalledWith({ exists: true, isPublished: true, sessionExists: true });
  });
});
