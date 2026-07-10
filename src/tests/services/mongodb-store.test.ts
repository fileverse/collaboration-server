import { describe, it, expect, vi, beforeEach } from "vitest";
import { DocumentUpdateModel } from "../../database/models/document-update";
import { CounterModel } from "../../database/models/counter";
import { MongoDBStore } from "../../services/mongodb-store";

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
    DocumentMetaModel: { findOneAndUpdate: vi.fn(), find: vi.fn(), findById: vi.fn(), updateMany: vi.fn().mockResolvedValue(undefined), deleteOne: vi.fn().mockResolvedValue(undefined) },
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

  it("relays without persisting when no non-terminated session backs the room", async () => {
    const { SessionModel, DocumentUpdateModel } = await import("../../database/models");
    (SessionModel.findOne as any).mockResolvedValue(null);
    const save = vi.fn();
    (DocumentUpdateModel as any).mockImplementation((doc: any) => ({ ...doc, save }));

    const store = new MongoDBStore();
    const result = await store.createUpdate({
      id: "u1", documentId: "doc-1", data: "ct", updateType: "yjs_update",
      committed: false, commitCid: null, createdAt: 1, sessionDid: "room-did", appType: "ddoc",
    });

    expect(save).not.toHaveBeenCalled();
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

  it("relays without persisting when the backing session is terminated", async () => {
    const { CounterModel, SessionModel } = await import("../../database/models");
    (SessionModel.findOne as any).mockResolvedValue({ state: "terminated" });

    const store = new MongoDBStore();
    const result = await store.createUpdate({
      id: "u1", documentId: "doc-1", data: "ct", updateType: "yjs_update",
      committed: false, commitCid: null, createdAt: 1, sessionDid: "room-did", appType: "ddoc",
    });

    expect(CounterModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(result.seq).toBeUndefined();
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
      portalAddress: "0xP", editLock: "el", title: "t",
    });

    expect(DocumentMetaModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "doc-1" },
      expect.objectContaining({
        $set: expect.objectContaining({
          sessionDid: "room-did", ownerDid: "od", ownerIdentityDid: "oid",
          portalAddress: "0xP", editLock: "el", title: "t",
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
      { documentId: "doc-1", editLock: "el-1", title: "t1" },
      { documentId: "doc-2", editLock: "el-2", title: "t2" },
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

  it("markDocumentsPublished updateMany sets isPublished for the given ids", async () => {
    const { DocumentMetaModel } = await import("../../database/models");
    const store = new MongoDBStore();
    await store.markDocumentsPublished(["d1", "d2"]);
    expect(DocumentMetaModel.updateMany).toHaveBeenCalledWith(
      { _id: { $in: ["d1", "d2"] } },
      { $set: { isPublished: true } }
    );
  });

  it("markDocumentsPublished no-ops on empty input", async () => {
    const { DocumentMetaModel } = await import("../../database/models");
    const store = new MongoDBStore();
    await store.markDocumentsPublished([]);
    expect(DocumentMetaModel.updateMany).not.toHaveBeenCalled();
  });

  it("returns an empty list when neither ownerIdentityDid nor ownerDid is given", async () => {
    const { DocumentMetaModel } = await import("../../database/models");
    const store = new MongoDBStore();
    const result = await store.listDocumentsForOwner({});

    expect(result).toEqual([]);
    expect(DocumentMetaModel.find).not.toHaveBeenCalled();
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
});

describe("purgeDocument", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wipes all five collections for the documentId", async () => {
    const { DocumentUpdateModel, DocumentCommitModel, DocumentMetaModel, SessionModel, CounterModel } =
      await import("../../database/models");

    const store = new MongoDBStore();
    await store.purgeDocument("doc-1");

    expect(DocumentUpdateModel.deleteMany).toHaveBeenCalledWith({ documentId: "doc-1" });
    expect(DocumentCommitModel.deleteMany).toHaveBeenCalledWith({ documentId: "doc-1" });
    expect(DocumentMetaModel.deleteOne).toHaveBeenCalledWith({ _id: "doc-1" });
    expect(SessionModel.deleteMany).toHaveBeenCalledWith({ documentId: "doc-1" });
    expect(CounterModel.deleteOne).toHaveBeenCalledWith({ _id: "doc-1" });
  });
});

describe("collectOrphans", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("purges a terminated ddoc stream with no editLock and no snapshot", async () => {
    const { SessionModel, DocumentMetaModel, DocumentUpdateModel } = await import("../../database/models");
    (SessionModel.find as any).mockReturnValue({ lean: vi.fn().mockResolvedValue([{ documentId: "orphan", sessionDid: "s" }]) });
    (DocumentMetaModel.findById as any) = vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }); // no editLock
    (DocumentUpdateModel.findOne as any).mockReturnValue({ sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }) }); // no snapshot

    const store = new MongoDBStore();
    const n = await store.collectOrphans(60_000);

    expect(DocumentUpdateModel.deleteMany).toHaveBeenCalledWith({ documentId: "orphan" });
    expect(n).toBe(1);
  });

  it("keeps a terminated stream that still has an editLock (real draft)", async () => {
    const { SessionModel, DocumentMetaModel, DocumentUpdateModel } = await import("../../database/models");
    (SessionModel.find as any).mockReturnValue({ lean: vi.fn().mockResolvedValue([{ documentId: "draft", sessionDid: "s" }]) });
    (DocumentMetaModel.findById as any) = vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue({ editLock: "el" }) });
    (DocumentUpdateModel.findOne as any).mockReturnValue({ sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }) });

    const store = new MongoDBStore();
    const n = await store.collectOrphans(60_000);
    expect(DocumentUpdateModel.deleteMany).not.toHaveBeenCalled();
    expect(n).toBe(0);
  });

  it("keeps a terminated stream that has no editLock but still has a snapshot (hydration base)", async () => {
    const { SessionModel, DocumentMetaModel, DocumentUpdateModel, CounterModel } = await import("../../database/models");
    (SessionModel.find as any).mockReturnValue({ lean: vi.fn().mockResolvedValue([{ documentId: "snapdraft", sessionDid: "s" }]) });
    (DocumentMetaModel.findById as any) = vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }); // no editLock
    (DocumentUpdateModel.findOne as any).mockReturnValue({ sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue({ _id: "snap1", documentId: "snapdraft", seq: 5 }) }) }); // snapshot exists

    const store = new MongoDBStore();
    const n = await store.collectOrphans(60_000);

    expect(DocumentUpdateModel.deleteMany).not.toHaveBeenCalled();
    expect(SessionModel.deleteMany).not.toHaveBeenCalled();
    expect(CounterModel.deleteOne).not.toHaveBeenCalled();
    expect(n).toBe(0);
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
