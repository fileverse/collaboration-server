import { describe, it, expect, vi, beforeEach } from "vitest";
import { DocumentUpdateModel } from "../../database/models/document-update";
import { CounterModel } from "../../database/models/counter";
import { MongoDBStore, SessionTerminatedError } from "../../services/mongodb-store";

vi.mock("../../database/models", () => {
  const save = vi.fn().mockResolvedValue(undefined);
  const DocumentUpdateModel: any = vi.fn().mockImplementation((doc) => ({ ...doc, save }));
  DocumentUpdateModel.find = vi.fn();
  DocumentUpdateModel.findById = vi.fn();
  DocumentUpdateModel.findOne = vi.fn();
  DocumentUpdateModel.updateMany = vi.fn().mockResolvedValue(undefined);
  DocumentUpdateModel.deleteMany = vi.fn().mockResolvedValue(undefined);
  DocumentUpdateModel.countDocuments = vi.fn().mockResolvedValue(0);

  const DocumentCommitModel: any = vi.fn();
  DocumentCommitModel.deleteMany = vi.fn().mockResolvedValue(undefined);

  return {
    DocumentUpdateModel,
    DocumentCommitModel,
    CounterModel: { findOneAndUpdate: vi.fn(), deleteOne: vi.fn().mockResolvedValue(undefined) },
    SessionModel: { findOne: vi.fn(), find: vi.fn(), deleteMany: vi.fn().mockResolvedValue(undefined) },
    DocumentMetaModel: { findOneAndUpdate: vi.fn(), find: vi.fn(), findById: vi.fn(), updateMany: vi.fn().mockResolvedValue(undefined), updateOne: vi.fn(), bulkWrite: vi.fn().mockResolvedValue(undefined), deleteOne: vi.fn().mockResolvedValue(undefined) },
    DocumentMirrorModel: {
      findOneAndUpdate: vi.fn().mockResolvedValue(undefined),
      findOne: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue(undefined),
    },
    DocumentEditEpochModel: { deleteOne: vi.fn().mockResolvedValue(undefined) },
  };
});

describe("createUpdate: seq assignment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("increments the per-document counter atomically and stamps the returned seq", async () => {
    const { CounterModel, SessionModel } = await import("../../database/models");
    (SessionModel.findOne as any).mockResolvedValue({ state: "active" });
    (CounterModel.findOneAndUpdate as any).mockResolvedValue({ _id: "doc-1", seq: 7 });

    const store = new MongoDBStore();
    const result = await store.createUpdate({
      id: "u1", documentId: "doc-1", data: "ciphertext", updateType: "yjs_update",
      committed: false, commitCid: null, createdAt: 123, sessionDid: "room-did", appType: "ddoc",
    });

    // Asserts the correct PRIMITIVE ($inc, upsert). Atomicity itself is DB-provided.
    expect(CounterModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "doc-1" },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );
    expect(result.seq).toBe(7);
  });
});

describe("createUpdate: durable-write gate", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { CounterModel, SessionModel } = await import("../../database/models");
    (CounterModel.findOneAndUpdate as any).mockResolvedValue({ _id: "doc-1", seq: 1 });
    (SessionModel.findOne as any).mockResolvedValue({ state: "active", ownerDid: "did:o" });
  });

  it("relays without persisting when no session row backs the room (missing row is NOT terminated — D-11 is terminated-only)", async () => {
    const { CounterModel, SessionModel, DocumentUpdateModel } = await import("../../database/models");
    (SessionModel.findOne as any).mockResolvedValue(null);
    const save = vi.fn();
    (DocumentUpdateModel as any).mockImplementation((doc: any) => ({ ...doc, save }));

    const store = new MongoDBStore();
    const input = {
      id: "u1", documentId: "doc-1", data: "ct", updateType: "yjs_update" as const,
      committed: false, commitCid: null, createdAt: 1, sessionDid: "room-did", appType: "ddoc" as const,
    };
    const result = await store.createUpdate(input);

    expect(result).toEqual(input);
    expect(save).not.toHaveBeenCalled();
    expect(CounterModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(result.seq).toBeUndefined();
  });

  it("persists when a live session backs the room", async () => {
    const store = new MongoDBStore();
    const result = await store.createUpdate({
      id: "u1", documentId: "doc-1", data: "ct", updateType: "yjs_update",
      committed: false, commitCid: null, createdAt: 1, sessionDid: "room-did", appType: "ddoc",
    });
    expect(result.seq).toBe(1);
  });

  it("rejects with SessionTerminatedError when the backing session is terminated (D-11: terminated-only, no ephemeral relay)", async () => {
    const { CounterModel, SessionModel } = await import("../../database/models");
    (SessionModel.findOne as any).mockResolvedValue({ state: "terminated" });

    const store = new MongoDBStore();
    await expect(
      store.createUpdate({
        id: "u1", documentId: "doc-1", data: "ct", updateType: "yjs_update",
        committed: false, commitCid: null, createdAt: 1, sessionDid: "room-did", appType: "ddoc",
      })
    ).rejects.toThrow(SessionTerminatedError);

    expect(CounterModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("stamps appType from the session row, not the caller", async () => {
    const { CounterModel, SessionModel, DocumentUpdateModel: MockedUpdateModel } =
      await import("../../database/models");
    (SessionModel.findOne as any).mockResolvedValue({ state: "active", appType: "dsheet" });
    (CounterModel.findOneAndUpdate as any).mockResolvedValue({ _id: "doc-1", seq: 1 });

    const store = new MongoDBStore();
    await store.createUpdate({
      id: "u1", documentId: "doc-1", data: "ct", updateType: "yjs_update",
      committed: false, commitCid: null, createdAt: 1, sessionDid: "room-did",
    });

    expect(MockedUpdateModel).toHaveBeenCalledWith(
      expect.objectContaining({ appType: "dsheet" })
    );
  });
});

describe("schema: seq ordering", () => {
  it("DocumentUpdate declares a required numeric seq path", () => {
    const path = DocumentUpdateModel.schema.path("seq");
    expect(path).toBeDefined();
    expect(path.instance).toBe("Number");
    expect(path.isRequired).toBe(true);
  });

  // DB-provided guarantee — the unit test only asserts the index is DECLARED unique;
  // actual collision-rejection is enforced by Mongo, integration/deploy-verified.
  it("DocumentUpdate declares a unique {documentId, seq} index", () => {
    const hasUnique = DocumentUpdateModel.schema.indexes().some(
      ([spec, opts]) =>
        spec.documentId === 1 && spec.seq === 1 && opts && opts.unique === true
    );
    expect(hasUnique).toBe(true);
  });

  it("Counter is keyed by string _id with a numeric seq", () => {
    expect(CounterModel.schema.path("seq").instance).toBe("Number");
  });
});

describe("createSnapshot: keep-latest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes the snapshot with majority write-concern then drops superseded snapshots", async () => {
    const { CounterModel, DocumentUpdateModel } = await import("../../database/models");
    (CounterModel.findOneAndUpdate as any).mockResolvedValue({ _id: "doc-1", seq: 12 });
    const save = vi.fn().mockResolvedValue(undefined);
    (DocumentUpdateModel as any).mockImplementation((doc: any) => ({ ...doc, save }));

    const store = new MongoDBStore();
    const result = await store.createSnapshot({
      id: "s1", documentId: "doc-1", data: "ct", updateType: "snapshot",
      committed: false, commitCid: null, createdAt: 1, sessionDid: "room-did",
      appType: "ddoc", publishedMarker: "blk-42", floorSeq: 5,
    });

    expect(result.seq).toBe(12);
    // The authorship floor is persisted on the row so hydration can cut the tail at it.
    expect(DocumentUpdateModel).toHaveBeenCalledWith(expect.objectContaining({ floorSeq: 5 }));
    expect(result.floorSeq).toBe(5);
    expect(save).toHaveBeenCalledWith({ w: "majority", j: true });
    expect(DocumentUpdateModel.deleteMany).toHaveBeenCalledWith({
      documentId: "doc-1", sessionDid: "room-did", updateType: "snapshot", seq: { $lt: 12 },
    });
  });
});

describe("mirror lane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("upserts keyed by (documentId, fileKeyEpoch), overwrite-in-place with NO destructive prune", async () => {
    const { DocumentMirrorModel } = await import("../../database/models");
    const store = new MongoDBStore();
    await store.upsertMirrorSnapshot({ documentId: "doc-1", data: "ct", fileKeyEpoch: 4, sessionDid: "sess-1", createdAt: 111 });

    expect(DocumentMirrorModel.findOneAndUpdate).toHaveBeenCalledWith(
      { documentId: "doc-1", fileKeyEpoch: 4 },
      { $set: { data: "ct", createdAt: 111, authorSessionDid: "sess-1" } },
      { upsert: true }
    );
    // A client-asserted epoch must NEVER trigger a delete of other rows.
    expect(DocumentMirrorModel.deleteMany).not.toHaveBeenCalled();
  });

  it("getLatestMirror returns the most recent row (by createdAt) or null", async () => {
    const { DocumentMirrorModel } = await import("../../database/models");
    const lean = vi.fn().mockResolvedValue({ documentId: "doc-1", fileKeyEpoch: 9, data: "ct", createdAt: 222 });
    const sort = vi.fn().mockReturnValue({ lean });
    (DocumentMirrorModel.findOne as any).mockReturnValue({ sort });
    const store = new MongoDBStore();
    expect(await store.getLatestMirror("doc-1")).toEqual({ data: "ct", fileKeyEpoch: 9, createdAt: 222 });
    expect(DocumentMirrorModel.findOne).toHaveBeenCalledWith({ documentId: "doc-1" });
    expect(sort).toHaveBeenCalledWith({ createdAt: -1 });

    (DocumentMirrorModel.findOne as any).mockReturnValue({ sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }) });
    expect(await store.getLatestMirror("doc-1")).toBeNull();
  });
});

describe("upsertDocumentMeta", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("upserts with majority write-concern", async () => {
    const { DocumentMetaModel } = await import("../../database/models");
    (DocumentMetaModel.findOneAndUpdate as any).mockResolvedValue({ _id: "doc-1" });

    const store = new MongoDBStore();
    await store.upsertDocumentMeta({
      documentId: "doc-1", sessionDid: "room-did", ownerDid: "od", ownerIdentityDid: "oid",
      portalAddress: "0xP", appType: "ddoc", editLock: "el", title: "t",
    });

    expect(DocumentMetaModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "doc-1" },
      expect.objectContaining({
        // Binding fields are first-writer-immutable (C1) — pinned on insert only.
        $setOnInsert: expect.objectContaining({
          ownerDid: "od", ownerIdentityDid: "oid", portalAddress: "0xP", appType: "ddoc",
        }),
        $set: expect.objectContaining({
          sessionDid: "room-did", editLock: "el", title: "t",
        }),
      }),
      expect.objectContaining({ upsert: true, writeConcern: { w: "majority", j: true } })
    );
  });
});

describe("listDocumentsForOwner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns docs bound to the owner identity DID", async () => {
    const { DocumentMetaModel } = await import("../../database/models");
    (DocumentMetaModel.find as any).mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([
          { _id: "doc-1", editLock: "el-1", title: "t1" },
          { _id: "doc-2", editLock: "el-2", title: "t2" },
        ]),
      }),
    });

    const store = new MongoDBStore();
    const result = await store.listDocumentsForOwner({ ownerIdentityDid: "did:key:zOwner" });

    expect(DocumentMetaModel.find).toHaveBeenCalledWith({
      ownerIdentityDid: "did:key:zOwner",
      isPublished: { $ne: true },
    });
    expect(result).toEqual([
      { documentId: "doc-1", editLock: "el-1", title: "t1", appType: "ddoc" },
      { documentId: "doc-2", editLock: "el-2", title: "t2", appType: "ddoc" },
    ]);
  });

  it("lists unpublished refs with a portalAddress, projected + limited", async () => {
    const { DocumentMetaModel } = await import("../../database/models");
    const limit = vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue([
        { _id: "d1", portalAddress: "0xP" },
        { _id: "d2", portalAddress: "0xQ" },
      ]),
    });
    (DocumentMetaModel.find as any).mockReturnValue({ select: vi.fn().mockReturnValue({ limit }) });

    const store = new MongoDBStore();
    const refs = await store.listUnpublishedMetaRefs(500);

    expect(DocumentMetaModel.find).toHaveBeenCalledWith({
      isPublished: { $ne: true },
      portalAddress: { $ne: null },
    });
    expect(limit).toHaveBeenCalledWith(500);
    expect(refs).toEqual([
      { documentId: "d1", portalAddress: "0xP" },
      { documentId: "d2", portalAddress: "0xQ" },
    ]);
  });

  it("markDocumentsPublished bulkWrite sets isPublished + onChainFileId per doc", async () => {
    const { DocumentMetaModel } = await import("../../database/models");
    const store = new MongoDBStore();
    await store.markDocumentsPublished([
      { documentId: "d1", fileId: "0" },
      { documentId: "d2", fileId: "3" },
    ]);
    expect(DocumentMetaModel.bulkWrite).toHaveBeenCalledWith([
      { updateOne: { filter: { _id: "d1" }, update: { $set: { isPublished: true, onChainFileId: "0" } } } },
      { updateOne: { filter: { _id: "d2" }, update: { $set: { isPublished: true, onChainFileId: "3" } } } },
    ]);
  });

  it("markDocumentsPublished no-ops on empty input", async () => {
    const { DocumentMetaModel } = await import("../../database/models");
    const store = new MongoDBStore();
    await store.markDocumentsPublished([]);
    expect(DocumentMetaModel.bulkWrite).not.toHaveBeenCalled();
  });

  it("returns an empty list when neither ownerIdentityDid nor ownerDid is given", async () => {
    const { DocumentMetaModel } = await import("../../database/models");
    const store = new MongoDBStore();
    const result = await store.listDocumentsForOwner({});

    expect(result).toEqual([]);
    expect(DocumentMetaModel.find).not.toHaveBeenCalled();
  });
});

describe("listDocumentsForOwner: appType routing", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns each row's appType, defaulting absent (legacy) rows to ddoc", async () => {
    const { DocumentMetaModel } = await import("../../database/models");
    const lean = vi.fn().mockResolvedValue([
      { _id: "doc-1", editLock: "lock", title: "t", appType: "dsheet" },
      { _id: "doc-2", editLock: null, title: null },
    ]);
    const select = vi.fn(() => ({ lean }));
    (DocumentMetaModel.find as any).mockReturnValue({ select });

    const store = new MongoDBStore();
    const docs = await store.listDocumentsForOwner({ ownerIdentityDid: "did:key:x" });

    expect(select).toHaveBeenCalledWith("editLock title appType");
    expect(docs).toEqual([
      { documentId: "doc-1", editLock: "lock", title: "t", appType: "dsheet" },
      { documentId: "doc-2", editLock: null, title: null, appType: "ddoc" },
    ]);
  });
});

describe("getHydrationRange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockFind(rows: any[]) {
    return { sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(rows) }) };
  }

  it("serves latest snapshot + tail after its floor when the client has no cursor", async () => {
    const { DocumentUpdateModel } = await import("../../database/models");
    (DocumentUpdateModel.findOne as any).mockReturnValue({
      sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue({ _id: "s1", documentId: "doc-1", seq: 10, floorSeq: 10, updateType: "snapshot", data: "ct", sessionDid: "room-did" }) }),
    });
    (DocumentUpdateModel.find as any).mockReturnValue(
      mockFind([{ _id: "u11", documentId: "doc-1", seq: 11, data: "ct", updateType: "yjs_update", sessionDid: "room-did" }])
    );

    const store = new MongoDBStore();
    const res = await store.getHydrationRange("doc-1", "room-did");

    expect(res.snapshot?.seq).toBe(10);
    expect(DocumentUpdateModel.find).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: "doc-1", sessionDid: "room-did", seq: { $gt: 10 } })
    );
    expect(res.updates.map((u) => u.seq)).toEqual([11]);
    expect(res.hasMore).toBe(false);
  });

  it("cuts the tail at the snapshot's floorSeq, not its own seq (gap-B: concurrent-writer orphan guard)", async () => {
    const { DocumentUpdateModel } = await import("../../database/models");
    // Snapshot's own seq is 12, but it is only provably complete up to floorSeq 7.
    (DocumentUpdateModel.findOne as any).mockReturnValue({
      sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue({ _id: "s1", documentId: "doc-1", seq: 12, floorSeq: 7, updateType: "snapshot", data: "ct", sessionDid: "room-did" }) }),
    });
    (DocumentUpdateModel.find as any).mockReturnValue(
      mockFind([{ _id: "u8", documentId: "doc-1", seq: 8, data: "ct", updateType: "yjs_update", sessionDid: "room-did" }])
    );

    const store = new MongoDBStore();
    const res = await store.getHydrationRange("doc-1", "room-did");

    // Must resume at > floorSeq (7), re-serving seq 8 — an update below the snapshot's own
    // seq (12) that the author may never have applied. Serving > snapshot.seq would orphan it.
    expect(res.snapshot?.seq).toBe(12);
    expect(DocumentUpdateModel.find).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: "doc-1", sessionDid: "room-did", seq: { $gt: 7 } })
    );
    expect(res.updates.map((u) => u.seq)).toEqual([8]);
  });

  it("trims an applied tail when sinceSeq is at or past the snapshot (no snapshot re-sent)", async () => {
    const { DocumentUpdateModel } = await import("../../database/models");
    (DocumentUpdateModel.findOne as any).mockReturnValue({
      sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue({ _id: "s1", seq: 10, floorSeq: 10, updateType: "snapshot", data: "ct" }) }),
    });
    (DocumentUpdateModel.find as any).mockReturnValue(mockFind([]));

    const store = new MongoDBStore();
    const res = await store.getHydrationRange("doc-1", "room-did", { sinceSeq: 15 });

    expect(res.snapshot).toBeNull();
    expect(DocumentUpdateModel.find).toHaveBeenCalledWith(
      expect.objectContaining({ seq: { $gt: 15 } })
    );
  });

  it("re-sends the snapshot and resumes at the floor when sinceSeq is behind the snapshot", async () => {
    const { DocumentUpdateModel } = await import("../../database/models");
    (DocumentUpdateModel.findOne as any).mockReturnValue({
      sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue({ _id: "s1", documentId: "doc-1", seq: 12, floorSeq: 10, updateType: "snapshot", data: "ct", sessionDid: "room-did" }) }),
    });
    (DocumentUpdateModel.find as any).mockReturnValue(mockFind([]));

    const store = new MongoDBStore();
    const res = await store.getHydrationRange("doc-1", "room-did", { sinceSeq: 5 });

    // Client is BEHIND the snapshot's floor → snapshot is NOT suppressed, and the tail resumes after the floor (10), not sinceSeq (5).
    expect(res.snapshot?.seq).toBe(12);
    expect(DocumentUpdateModel.find).toHaveBeenCalledWith(
      expect.objectContaining({ seq: { $gt: 10 } })
    );
  });

  it("stops at the byte budget: returns hasMore + nextSeq at the last admitted update", async () => {
    const { DocumentUpdateModel } = await import("../../database/models");
    (DocumentUpdateModel.findOne as any).mockReturnValue({
      sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }), // no snapshot
    });
    const big = "x".repeat(100);
    (DocumentUpdateModel.find as any).mockReturnValue(mockFind([
      { _id: "u1", documentId: "doc-1", seq: 1, data: big, updateType: "yjs_update", sessionDid: "room-did" },
      { _id: "u2", documentId: "doc-1", seq: 2, data: big, updateType: "yjs_update", sessionDid: "room-did" },
    ]));

    const store = new MongoDBStore();
    const res = await store.getHydrationRange("doc-1", "room-did", { maxBytes: 150 });

    // u1 (100B) admitted; u2 pushes total to 200 > 150 → break. First row always admitted (no stall).
    expect(res.updates.map((u) => u.seq)).toEqual([1]);
    expect(res.hasMore).toBe(true);
    expect(res.nextSeq).toBe(1);
  });

  it("serves a budget-filling snapshot alone, with the cursor resuming at the floor", async () => {
    const { DocumentUpdateModel } = await import("../../database/models");
    (DocumentUpdateModel.findOne as any).mockReturnValue({
      sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue({ _id: "s1", documentId: "doc-1", seq: 12, floorSeq: 10, updateType: "snapshot", data: "x".repeat(200), sessionDid: "room-did" }) }),
    });
    (DocumentUpdateModel.find as any).mockReturnValue(mockFind([
      { _id: "u11", documentId: "doc-1", seq: 11, data: "x".repeat(100), updateType: "yjs_update", sessionDid: "room-did" },
    ]));

    const store = new MongoDBStore();
    const res = await store.getHydrationRange("doc-1", "room-did", { maxBytes: 150 });

    // Snapshot (200B) alone exceeds the budget — force-including u11 could push the emit
    // past the socket buffer. Serve the snapshot by itself; the next page (sinceSeq = 10)
    // suppresses the snapshot and starts from a zero byte count.
    expect(res.snapshot?.seq).toBe(12);
    expect(res.updates).toEqual([]);
    expect(res.hasMore).toBe(true);
    expect(res.nextSeq).toBe(10);
  });
});

describe("purgeDocument", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wipes all seven collections for the documentId", async () => {
    const { DocumentUpdateModel, DocumentCommitModel, DocumentMetaModel, SessionModel, CounterModel, DocumentMirrorModel, DocumentEditEpochModel } =
      await import("../../database/models");

    const store = new MongoDBStore();
    await store.purgeDocument("doc-1");

    expect(DocumentUpdateModel.deleteMany).toHaveBeenCalledWith({ documentId: "doc-1" });
    expect(DocumentCommitModel.deleteMany).toHaveBeenCalledWith({ documentId: "doc-1" });
    expect(DocumentMetaModel.deleteOne).toHaveBeenCalledWith({ _id: "doc-1" });
    expect(SessionModel.deleteMany).toHaveBeenCalledWith({ documentId: "doc-1" });
    expect(CounterModel.deleteOne).toHaveBeenCalledWith({ _id: "doc-1" });
    expect(DocumentMirrorModel.deleteMany).toHaveBeenCalledWith({ documentId: "doc-1" });
    expect(DocumentEditEpochModel.deleteOne).toHaveBeenCalledWith({ _id: "doc-1" });
  });
});

describe("collectOrphans", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // No live sibling session on the documentId — the sweep's default posture in every
  // case below except the one that specifically tests the live-sibling guard.
  function mockNoLiveSibling(SessionModel: any) {
    (SessionModel.findOne as any).mockReturnValue({ select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }) });
  }

  it("purges a terminated ddoc stream with no editLock and no snapshot", async () => {
    const { SessionModel, DocumentMetaModel, DocumentUpdateModel, DocumentCommitModel } = await import("../../database/models");
    (SessionModel.find as any).mockReturnValue({ lean: vi.fn().mockResolvedValue([{ documentId: "orphan", sessionDid: "s", portalAddress: null }]) });
    mockNoLiveSibling(SessionModel);
    (DocumentMetaModel.findById as any) = vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }); // no editLock
    (DocumentUpdateModel.findOne as any).mockReturnValue({
      sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }), // no snapshot
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }), // no pre-durable legacy row
    });

    const store = new MongoDBStore();
    const n = await store.collectOrphans(60_000);

    expect(DocumentUpdateModel.deleteMany).toHaveBeenCalledWith({ documentId: "orphan" });
    expect(DocumentCommitModel.deleteMany).toHaveBeenCalledWith({ documentId: "orphan" });
    expect(n).toBe(1);
  });

  it("spares a document that still has a non-terminated sibling session", async () => {
    const { SessionModel, DocumentMetaModel, DocumentUpdateModel, DocumentCommitModel, CounterModel } = await import("../../database/models");
    (SessionModel.find as any).mockReturnValue({ lean: vi.fn().mockResolvedValue([{ documentId: "shared-doc", sessionDid: "s", portalAddress: null }]) });
    (SessionModel.findOne as any).mockReturnValue({ select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue({ _id: "live-session" }) }) });

    const store = new MongoDBStore();
    const n = await store.collectOrphans(60_000);

    expect(SessionModel.findOne).toHaveBeenCalledWith({ documentId: "shared-doc", state: { $ne: "terminated" } });
    // The live-sibling guard short-circuits before any of the other guards run.
    expect(DocumentMetaModel.findById).not.toHaveBeenCalled();
    expect(DocumentUpdateModel.deleteMany).not.toHaveBeenCalled();
    expect(DocumentCommitModel.deleteMany).not.toHaveBeenCalled();
    expect(SessionModel.deleteMany).not.toHaveBeenCalled();
    expect(CounterModel.deleteOne).not.toHaveBeenCalled();
    expect(n).toBe(0);
  });

  it("keeps a terminated stream that still has an editLock (real draft)", async () => {
    const { SessionModel, DocumentMetaModel, DocumentUpdateModel, DocumentCommitModel } = await import("../../database/models");
    (SessionModel.find as any).mockReturnValue({ lean: vi.fn().mockResolvedValue([{ documentId: "draft", sessionDid: "s", portalAddress: null }]) });
    mockNoLiveSibling(SessionModel);
    (DocumentMetaModel.findById as any) = vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue({ editLock: "el" }) });
    (DocumentUpdateModel.findOne as any).mockReturnValue({ sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }) });

    const store = new MongoDBStore();
    const n = await store.collectOrphans(60_000);
    expect(DocumentMetaModel.findById).toHaveBeenCalledWith("draft"); // guard genuinely consulted the editLock
    expect(DocumentUpdateModel.deleteMany).not.toHaveBeenCalled();
    expect(DocumentCommitModel.deleteMany).not.toHaveBeenCalled();
    expect(n).toBe(0);
  });

  it("keeps a terminated stream that has no editLock but still has a snapshot (hydration base)", async () => {
    const { SessionModel, DocumentMetaModel, DocumentUpdateModel, DocumentCommitModel, CounterModel } = await import("../../database/models");
    (SessionModel.find as any).mockReturnValue({ lean: vi.fn().mockResolvedValue([{ documentId: "snapdraft", sessionDid: "s", portalAddress: null }]) });
    mockNoLiveSibling(SessionModel);
    (DocumentMetaModel.findById as any) = vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }); // no editLock
    (DocumentUpdateModel.findOne as any).mockReturnValue({ sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue({ _id: "snap1", documentId: "snapdraft", seq: 5 }) }) }); // snapshot exists

    const store = new MongoDBStore();
    const n = await store.collectOrphans(60_000);

    expect(DocumentUpdateModel.findOne).toHaveBeenCalled(); // guard genuinely consulted the snapshot query
    expect(DocumentUpdateModel.deleteMany).not.toHaveBeenCalled();
    expect(DocumentCommitModel.deleteMany).not.toHaveBeenCalled();
    expect(SessionModel.deleteMany).not.toHaveBeenCalled();
    expect(CounterModel.deleteOne).not.toHaveBeenCalled();
    expect(n).toBe(0);
  });

  it("queries terminated sessions across BOTH app types (no appType filter)", async () => {
    const { SessionModel } = await import("../../database/models");
    (SessionModel.find as any).mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });

    const store = new MongoDBStore();
    await store.collectOrphans(1000);

    expect(SessionModel.find).toHaveBeenCalledWith({
      state: "terminated", createdAt: { $lt: expect.any(Date) },
    });
  });
});

describe("getShareContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports existence and isPublished", async () => {
    const { DocumentMetaModel } = await import("../../database/models");
    (DocumentMetaModel.findById as any).mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ isPublished: false }),
      }),
    });

    const store = new MongoDBStore();
    expect(await store.getShareContext("doc-sc-none")).toEqual({
      exists: false, isPublished: false,
    });
    expect(DocumentMetaModel.findById).toHaveBeenCalledWith("doc-sc-none");

    expect(await store.getShareContext("doc-sc-2")).toEqual({
      exists: true, isPublished: false,
    });
  });

  it("reports isPublished true only for a strict boolean", async () => {
    const { DocumentMetaModel } = await import("../../database/models");
    (DocumentMetaModel.findById as any).mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn()
          .mockResolvedValueOnce({ isPublished: true })
          .mockResolvedValueOnce({}),
      }),
    });

    const store = new MongoDBStore();
    expect((await store.getShareContext("doc-sc-pub")).isPublished).toBe(true);
    // legacy row with no isPublished field normalizes to false
    expect((await store.getShareContext("doc-sc-legacy")).isPublished).toBe(false);
  });
});

describe("markUpdatesAsCommitted scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scopes the update to the documentId (no cross-doc commit-flip)", async () => {
    const { DocumentUpdateModel } = await import("../../database/models");
    const store = new MongoDBStore();
    await store.markUpdatesAsCommitted(["u1", "u2"], "cid-1", "doc-1");
    expect(DocumentUpdateModel.updateMany).toHaveBeenCalledWith(
      { _id: { $in: ["u1", "u2"] }, documentId: "doc-1" },
      { committed: true, commitCid: "cid-1" }
    );
  });
});
