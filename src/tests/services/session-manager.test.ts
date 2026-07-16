import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionManager } from "../../services/session-manager";
import { SessionModel, DocumentUpdateModel, DocumentCommitModel } from "../../database/models";

vi.mock("../../database/models", () => ({
  SessionModel: {
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    find: vi.fn(),
    countDocuments: vi.fn(),
    updateOne: vi.fn(),
  },
  DocumentUpdateModel: {
    deleteMany: vi.fn(),
  },
  DocumentCommitModel: {
    deleteMany: vi.fn(),
  },
}));

describe("SessionManager", () => {
  let sessionManager: SessionManager;

  beforeEach(async () => {
    vi.mocked(SessionModel.findOneAndUpdate).mockResolvedValue({} as any);
    sessionManager = new SessionManager();
    await sessionManager.createSession({
      documentId: "doc-1",
      sessionDid: "session-1",
      ownerDid: "owner-did",
    });
    vi.clearAllMocks();
  });

  // addClientToSession

  it("adds a client to an existing in-memory session and reactivates it in the database", async () => {
    const result = await sessionManager.addClientToSession("doc-1", "session-1", "client-1");

    expect(SessionModel.findOneAndUpdate).toHaveBeenCalledWith(
      { documentId: "doc-1", sessionDid: "session-1" },
      { state: "active" }
    );
    expect(SessionModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(result).toBe(true);
  });

  it("returns false when the session is not found", async () => {
    vi.mocked(SessionModel.findOne).mockResolvedValue(null);

    const result = await sessionManager.addClientToSession("doc-1", "unknown-session", "client-1");

    expect(SessionModel.findOne).toHaveBeenCalledWith({
      documentId: "doc-1",
      sessionDid: "unknown-session",
      state: { $ne: "terminated" },
    });
    expect(SessionModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  // getSession

  it("returns the in-memory session without hitting the database", async () => {
    const session = await sessionManager.getSession("doc-1", "session-1");

    expect(SessionModel.findOne).not.toHaveBeenCalled();
    expect(session).toEqual({
      documentId: "doc-1",
      sessionDid: "session-1",
      ownerDid: "owner-did",
      clients: new Set(),
    });
  });

  it("falls back to the database, hydrates in-memory, and returns the session", async () => {
    const freshManager = new SessionManager();
    vi.mocked(SessionModel.findOne).mockResolvedValue({
      documentId: "doc-1",
      sessionDid: "session-1",
      ownerDid: "owner-did",
      roomInfo: "room-info",
    } as any);

    const session = await freshManager.getSession("doc-1", "session-1");

    expect(SessionModel.findOne).toHaveBeenCalledWith({
      documentId: "doc-1",
      sessionDid: "session-1",
      state: { $ne: "terminated" },
    });
    expect(session).toEqual({
      documentId: "doc-1",
      sessionDid: "session-1",
      ownerDid: "owner-did",
      clients: new Set(),
      roomInfo: "room-info",
    });

    await freshManager.destroy();
  });

  it("returns undefined when the session is not found in memory or the database", async () => {
    vi.mocked(SessionModel.findOne).mockResolvedValue(null);

    const session = await sessionManager.getSession("doc-1", "unknown-session");

    expect(session).toBeUndefined();
  });

  // removeClientFromSession

  it("removes a client without deactivating when other clients remain", async () => {
    await sessionManager.addClientToSession("doc-1", "session-1", "client-1");
    await sessionManager.addClientToSession("doc-1", "session-1", "client-2");
    vi.clearAllMocks();

    await sessionManager.removeClientFromSession("doc-1", "session-1", "client-1");

    expect(SessionModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("deactivates the session when the last client is removed", async () => {
    await sessionManager.addClientToSession("doc-1", "session-1", "client-1");
    vi.clearAllMocks();

    await sessionManager.removeClientFromSession("doc-1", "session-1", "client-1");

    expect(SessionModel.findOneAndUpdate).toHaveBeenCalledWith(
      { documentId: "doc-1", sessionDid: "session-1" },
      { state: "inactive" }
    );
    expect(SessionModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  // deactivateSession

  it("removes the session from memory and marks it inactive in the database", async () => {
    await sessionManager.deactivateSession("doc-1", "session-1");

    expect(sessionManager.getLocalClients("doc-1", "session-1")).toBeUndefined();
    expect(SessionModel.findOneAndUpdate).toHaveBeenCalledWith(
      { documentId: "doc-1", sessionDid: "session-1" },
      { state: "inactive" }
    );
    expect(SessionModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  // terminateSession

  it("removes the session from memory and cleans up all related data in the database", async () => {
    await sessionManager.terminateSession("doc-1", "session-1", "dsheet");

    expect(sessionManager.getLocalClients("doc-1", "session-1")).toBeUndefined();
    expect(SessionModel.findOneAndUpdate).toHaveBeenCalledWith(
      { documentId: "doc-1", sessionDid: "session-1" },
      { state: "terminated", roomInfo: null }
    );
    expect(DocumentUpdateModel.deleteMany).toHaveBeenCalledWith({
      documentId: "doc-1",
      sessionDid: "session-1",
    });
    expect(DocumentCommitModel.deleteMany).toHaveBeenCalledWith({
      documentId: "doc-1",
      sessionDid: "session-1",
    });
  });

  it("ddoc terminate marks the session terminated but keeps updates + commits", async () => {
    await sessionManager.terminateSession("doc-1", "session-1", "ddoc");

    expect(SessionModel.findOneAndUpdate).toHaveBeenCalledWith(
      { documentId: "doc-1", sessionDid: "session-1" },
      { state: "terminated", roomInfo: null }
    );
    expect(DocumentUpdateModel.deleteMany).not.toHaveBeenCalled();
    expect(DocumentCommitModel.deleteMany).not.toHaveBeenCalled();
  });

  it("dsheet terminate keeps the cascade delete", async () => {
    await sessionManager.terminateSession("doc-1", "session-1", "dsheet");

    expect(DocumentUpdateModel.deleteMany).toHaveBeenCalledWith({
      documentId: "doc-1",
      sessionDid: "session-1",
    });
    expect(DocumentCommitModel.deleteMany).toHaveBeenCalledWith({
      documentId: "doc-1",
      sessionDid: "session-1",
    });
  });

  // getOtherNonTerminatedSessions

  it("returns other non-terminated sessions (incl. inactive) excluding the given sessionDid", async () => {
    vi.mocked(SessionModel.find).mockResolvedValue([
      { documentId: "doc-1", sessionDid: "other-session-1", appType: "ddoc" },
      { documentId: "doc-1", sessionDid: "other-session-2", appType: "dsheet" },
    ] as any);

    const sessions = await sessionManager.getOtherNonTerminatedSessions(
      "doc-1",
      "owner-did",
      null,
      "session-1"
    );

    expect(SessionModel.find).toHaveBeenCalledWith({
      documentId: "doc-1",
      state: { $ne: "terminated" },
      $or: [{ ownerDid: "owner-did" }],
      sessionDid: { $ne: "session-1" },
    });
    expect(sessions).toEqual([
      { documentId: "doc-1", sessionDid: "other-session-1", appType: "ddoc" },
      { documentId: "doc-1", sessionDid: "other-session-2", appType: "dsheet" },
    ]);
  });

  // getNonTerminatedSessionsForDocument

  it("returns every non-terminated sessionDid for a document regardless of owner", async () => {
    vi.mocked(SessionModel.find).mockReturnValue({
      lean: vi.fn().mockResolvedValue([
        { sessionDid: "s-1" },
        { sessionDid: "s-2" },
      ]),
    } as any);

    const sessions = await sessionManager.getNonTerminatedSessionsForDocument("doc-1");

    expect(SessionModel.find).toHaveBeenCalledWith(
      { documentId: "doc-1", state: { $ne: "terminated" } },
      { sessionDid: 1 }
    );
    expect(sessions).toEqual([{ sessionDid: "s-1" }, { sessionDid: "s-2" }]);
  });

  // getActiveSessionsCount

  it("returns the in-memory session count when sessions are present", async () => {
    const count = await sessionManager.getActiveSessionsCount();

    expect(SessionModel.countDocuments).not.toHaveBeenCalled();
    expect(count).toBe(1);
  });

  it("falls back to the database count when no in-memory sessions exist", async () => {
    const freshManager = new SessionManager();
    vi.mocked(SessionModel.countDocuments).mockResolvedValue(5 as any);

    const count = await freshManager.getActiveSessionsCount();

    expect(SessionModel.countDocuments).toHaveBeenCalledWith({ state: "active" });
    expect(count).toBe(5);

    await freshManager.destroy();
  });

  // updateRoomInfo

  it("updates room info in-memory and in the database", async () => {
    await sessionManager.updateRoomInfo("doc-1", "session-1", "owner-did", "new-room-info");

    expect(SessionModel.findOneAndUpdate).toHaveBeenCalledWith(
      { documentId: "doc-1", sessionDid: "session-1", ownerDid: "owner-did" },
      { roomInfo: "new-room-info" }
    );
    expect(SessionModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const session = await sessionManager.getSession("doc-1", "session-1");
    expect(session?.roomInfo).toBe("new-room-info");
  });

  // getLocalClients

  it("returns the client Set for a session in memory", async () => {
    await sessionManager.addClientToSession("doc-1", "session-1", "client-1");
    vi.clearAllMocks();

    const clients = sessionManager.getLocalClients("doc-1", "session-1");

    expect(clients).toEqual(new Set(["client-1"]));
  });

  it("returns undefined when the session is not in memory", () => {
    const clients = sessionManager.getLocalClients("doc-1", "unknown-session");

    expect(clients).toBeUndefined();
  });

  // appType

  it("persists the provided appType and exposes it on the in-memory session", async () => {
    const freshManager = new SessionManager();

    await freshManager.createSession({
      documentId: "doc-2",
      sessionDid: "session-2",
      ownerDid: "owner-did",
      appType: "dsheet",
    });

    expect(SessionModel.findOneAndUpdate).toHaveBeenCalledWith(
      { documentId: "doc-2", sessionDid: "session-2" },
      expect.objectContaining({ $set: expect.objectContaining({ appType: "dsheet" }) }),
      { upsert: true, new: true }
    );
    const session = await freshManager.getSession("doc-2", "session-2");
    expect(session?.appType).toBe("dsheet");

    await freshManager.destroy();
  });

  it("defaults appType to ddoc when none is provided", async () => {
    const freshManager = new SessionManager();

    await freshManager.createSession({
      documentId: "doc-3",
      sessionDid: "session-3",
      ownerDid: "owner-did",
    });

    expect(SessionModel.findOneAndUpdate).toHaveBeenCalledWith(
      { documentId: "doc-3", sessionDid: "session-3" },
      expect.objectContaining({ $set: expect.objectContaining({ appType: "ddoc" }) }),
      { upsert: true, new: true }
    );

    await freshManager.destroy();
  });

  // R3 owner-identity binding

  it("binds ownerIdentityDid + portalAddress via $setOnInsert (immutable) and mutable fields via $set", async () => {
    const freshManager = new SessionManager();

    await freshManager.createSession({
      documentId: "doc-bind", sessionDid: "sess-bind", ownerDid: "owner-did",
      ownerIdentityDid: "did:identity:owner", portalAddress: "0xPortal",
      roomInfo: "room", appType: "ddoc", collabJoinEnabled: false,
    });

    // Asserts the correct PRIMITIVE ($setOnInsert). First-writer-immutability itself is DB-provided.
    expect(SessionModel.findOneAndUpdate).toHaveBeenCalledWith(
      { documentId: "doc-bind", sessionDid: "sess-bind" },
      {
        $setOnInsert: {
          ownerDid: "owner-did",
          ownerIdentityDid: "did:identity:owner",
          portalAddress: "0xPortal",
          collabJoinEnabled: false,
        },
        $set: { state: "active", roomInfo: "room", appType: "ddoc" },
      },
      { upsert: true, new: true }
    );

    await freshManager.destroy();
  });

  // setCollabJoinEnabled

  it("setCollabJoinEnabled updates the DB and the in-memory session", async () => {
    await sessionManager.setCollabJoinEnabled("doc-1", "session-1", true);
    expect(SessionModel.findOneAndUpdate).toHaveBeenCalledWith(
      { documentId: "doc-1", sessionDid: "session-1" },
      { collabJoinEnabled: true }
    );
    const session = await sessionManager.getSession("doc-1", "session-1");
    expect(session?.collabJoinEnabled).toBe(true);
  });

  it("hydrates appType from the database on fallback", async () => {
    const freshManager = new SessionManager();
    vi.mocked(SessionModel.findOne).mockResolvedValue({
      documentId: "doc-1",
      sessionDid: "session-1",
      ownerDid: "owner-did",
      roomInfo: "room-info",
      appType: "dsheet",
    } as any);

    const session = await freshManager.getSession("doc-1", "session-1");

    expect(session?.appType).toBe("dsheet");

    await freshManager.destroy();
  });

  // updateSessionOwnerDid

  describe("updateSessionOwnerDid", () => {
    it("persists the new ownerDid and mirrors it in memory", async () => {
      const freshManager = new SessionManager();
      await freshManager.createSession({
        documentId: "doc1",
        sessionDid: "sess1",
        ownerDid: "did:key:old",
        portalAddress: "0x" + "a".repeat(40),
        collabJoinEnabled: false,
      } as any);
      vi.clearAllMocks();

      await freshManager.updateSessionOwnerDid("doc1", "sess1", "did:key:new");

      expect(SessionModel.updateOne).toHaveBeenCalledWith(
        { documentId: "doc1", sessionDid: "sess1" },
        { $set: { ownerDid: "did:key:new" } }
      );
      const session = await freshManager.getSession("doc1", "sess1");
      expect(session?.ownerDid).toBe("did:key:new");

      await freshManager.destroy();
    });
  });

  // getNonTerminatedSessionsForPortal

  describe("getNonTerminatedSessionsForPortal", () => {
    it("matches portalAddress case-insensitively and excludes terminated", async () => {
      const portal = "0x" + "A".repeat(40);
      vi.mocked(SessionModel.find).mockReturnValue({
        lean: vi.fn().mockResolvedValue([{ documentId: "doc-1", sessionDid: "sess-1" }]),
      } as any);

      const sessions = await sessionManager.getNonTerminatedSessionsForPortal(portal);

      expect(SessionModel.find).toHaveBeenCalledWith(
        {
          portalAddress: { $regex: `^${portal}$`, $options: "i" },
          state: { $ne: "terminated" },
        },
        { documentId: 1, sessionDid: 1 }
      );
      expect(sessions).toEqual([{ documentId: "doc-1", sessionDid: "sess-1" }]);
    });

    it("returns [] for a non-hex portalAddress without querying", async () => {
      const out = await sessionManager.getNonTerminatedSessionsForPortal("not-an-address');--");

      expect(out).toEqual([]);
      expect(SessionModel.find).not.toHaveBeenCalled();
    });
  });

  // getOtherNonTerminatedSessions ($or sweep)

  describe("getOtherNonTerminatedSessions ($or sweep)", () => {
    it("matches by portalAddress even when ownerDid differs (post-rotation orphan)", async () => {
      const portal = "0x" + "a".repeat(40);
      vi.mocked(SessionModel.find).mockResolvedValue([
        { documentId: "doc-1", sessionDid: "orphan-session", ownerDid: "did:key:old", appType: "ddoc" },
      ] as any);

      const sessions = await sessionManager.getOtherNonTerminatedSessions("doc-1", "did:key:new", portal);

      expect(SessionModel.find).toHaveBeenCalledWith({
        documentId: "doc-1",
        state: { $ne: "terminated" },
        $or: [{ ownerDid: "did:key:new" }, { portalAddress: { $regex: `^${portal}$`, $options: "i" } }],
      });
      expect(sessions).toEqual([{ documentId: "doc-1", sessionDid: "orphan-session", appType: "ddoc" }]);
    });

    it("still matches legacy null-portal sessions by ownerDid", async () => {
      vi.mocked(SessionModel.find).mockResolvedValue([
        { documentId: "doc-1", sessionDid: "legacy-session", ownerDid: "did:key:x", appType: "ddoc" },
      ] as any);

      const sessions = await sessionManager.getOtherNonTerminatedSessions("doc-1", "did:key:x", null);

      expect(SessionModel.find).toHaveBeenCalledWith({
        documentId: "doc-1",
        state: { $ne: "terminated" },
        $or: [{ ownerDid: "did:key:x" }],
      });
      expect(sessions).toEqual([{ documentId: "doc-1", sessionDid: "legacy-session", appType: "ddoc" }]);
    });
  });
});
