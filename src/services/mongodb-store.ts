import { DocumentUpdate, DocumentCommit } from "../types/index";
import { DocumentUpdateModel, DocumentCommitModel, CounterModel, SessionModel, DocumentMetaModel, DocumentMirrorModel, DocumentEditEpochModel } from "../database/models";

export class SessionTerminatedError extends Error {
  constructor() { super("session terminated"); this.name = "SessionTerminatedError"; }
}

export class MongoDBStore {
  // Update management
  async createUpdate(update: DocumentUpdate): Promise<DocumentUpdate> {
    try {
      const session: any = await SessionModel.findOne({
        documentId: update.documentId,
        sessionDid: update.sessionDid,
      });
      if (session?.state === "terminated") {
        throw new SessionTerminatedError();
      }
      if (!session) {
        return update; // ephemeral relay — no durable row, no seq burned
      }

      const counter = await CounterModel.findOneAndUpdate(
        { _id: update.documentId },
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
      );
      const seq = counter!.seq;

      const mongoUpdate = new DocumentUpdateModel({
        _id: update.id,
        documentId: update.documentId,
        seq,
        data: update.data,
        updateType: update.updateType,
        committed: update.committed,
        commitCid: update.commitCid,
        createdAt: update.createdAt,
        sessionDid: update.sessionDid,
        appType: update.appType,
      });

      await mongoUpdate.save();
      return { ...update, seq };
    } catch (error) {
      if (!(error instanceof SessionTerminatedError)) {
        console.error("Error creating update:", error);
      }
      throw error;
    }
  }

  async getUpdate(updateId: string): Promise<DocumentUpdate | undefined> {
    try {
      const update = await DocumentUpdateModel.findById(updateId);
      if (!update) return undefined;

      return {
        id: update._id,
        documentId: update.documentId,
        data: update.data,
        updateType: update.updateType,
        committed: update.committed,
        commitCid: update.commitCid,
        createdAt: update.createdAt,
        sessionDid: update.sessionDid,
        seq: update.seq,
      };
    } catch (error) {
      console.error("Error getting update:", error);
      return undefined;
    }
  }

  async getUpdatesByDocument(
    filters: { documentId: string; sessionDid: string },
    options: {
      limit?: number;
      offset?: number;
      committed?: boolean;
      sort?: "asc" | "desc";
    } = {}
  ): Promise<DocumentUpdate[]> {
    try {
      let query = DocumentUpdateModel.find(filters);

      // Filter by committed status
      if (options.committed !== undefined) {
        query = query.where({ committed: options.committed });
      }

      // Sort by creation time
      const sortOrder = options.sort === "desc" ? -1 : 1;
      query = query.sort({ createdAt: sortOrder });
      // Apply pagination
      if (options.offset !== undefined && options.offset > 0) {
        query = query.skip(options.offset);
      }
      if (options.limit !== undefined && options.limit > 0) {
        query = query.limit(options.limit);
      }

      const updates = await query.exec();

      return updates.map((update) => ({
        id: update._id,
        documentId: update.documentId,

        data: update.data,
        updateType: update.updateType,
        committed: update.committed,
        commitCid: update.commitCid,
        createdAt: update.createdAt,
        sessionDid: update.sessionDid,
        seq: update.seq,
      }));
    } catch (error) {
      console.error("Error getting updates by document:", error);
      return [];
    }
  }

  async markUpdatesAsCommitted(updateIds: string[], commitId: string, documentId: string) {
    try {
      await DocumentUpdateModel.updateMany(
        { _id: { $in: updateIds }, documentId },
        {
          committed: true,
          commitCid: commitId,
        }
      );
    } catch (error) {
      console.error("Error marking updates as committed:", error);
      throw error;
    }
  }

  async createSnapshot(snapshot: DocumentUpdate): Promise<DocumentUpdate> {
    const counter = await CounterModel.findOneAndUpdate(
      { _id: snapshot.documentId },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );
    const seq = counter!.seq;

    const doc = new DocumentUpdateModel({
      _id: snapshot.id,
      documentId: snapshot.documentId,
      seq,
      data: snapshot.data,
      updateType: "snapshot",
      publishedMarker: snapshot.publishedMarker ?? null,
      floorSeq: snapshot.floorSeq ?? null,
      committed: false,
      commitCid: null,
      createdAt: snapshot.createdAt,
      sessionDid: snapshot.sessionDid,
      appType: snapshot.appType,
    });
    await doc.save({ w: "majority", j: true });

    // Keep-latest: a superseded snapshot is unconditionally safe to drop.
    await DocumentUpdateModel.deleteMany({
      documentId: snapshot.documentId,
      sessionDid: snapshot.sessionDid,
      updateType: "snapshot",
      seq: { $lt: seq },
    });

    return { ...snapshot, seq, updateType: "snapshot" };
  }

  /**
   * View-plane keep-latest: one row per (documentId, fileKeyEpoch), overwritten in place.
   * fileKeyEpoch is client-asserted, so it never drives a destructive prune — recency comes
   * from the server-stamped createdAt at read time.
   */
  async upsertMirrorSnapshot(mirror: {
    documentId: string;
    data: string;
    fileKeyEpoch: number;
    sessionDid: string;
    createdAt: number;
  }): Promise<void> {
    await DocumentMirrorModel.findOneAndUpdate(
      { documentId: mirror.documentId, fileKeyEpoch: mirror.fileKeyEpoch },
      { $set: { data: mirror.data, createdAt: mirror.createdAt, authorSessionDid: mirror.sessionDid } },
      { upsert: true }
    );
  }

  /** The most recently written mirror snapshot (server-stamped createdAt), or null. Open read. */
  async getLatestMirror(
    documentId: string
  ): Promise<{ data: string; fileKeyEpoch: number; createdAt: number } | null> {
    const row: any = await DocumentMirrorModel.findOne({ documentId }).sort({ createdAt: -1 }).lean();
    if (!row) return null;
    return { data: row.data, fileKeyEpoch: row.fileKeyEpoch, createdAt: row.createdAt };
  }

  async getCurrentSeq(documentId: string): Promise<number> {
    const counter: any = await CounterModel.findById(documentId).lean();
    return counter?.seq ?? 0;
  }

  async getHydrationRange(
    documentId: string,
    sessionDid: string,
    options: { sinceSeq?: number; maxBytes?: number } = {}
  ): Promise<{ snapshot: DocumentUpdate | null; updates: DocumentUpdate[]; nextSeq: number | null; hasMore: boolean }> {
    const maxBytes = options.maxBytes ?? 9 * 1024 * 1024; // headroom under the 10MB socket buffer

    const snapshotDoc: any = await DocumentUpdateModel.findOne({
      documentId, sessionDid, updateType: "snapshot",
    }).sort({ seq: -1 }).lean();

    // Cut the tail at the snapshot's authorship FLOOR, not its own seq: the snapshot is
    // only provably complete up to floorSeq, so seq > floorSeq re-serves any update the
    // author never applied (persist-before-fanout race) instead of orphaning it below the
    // snapshot's seq. Legacy floor-less snapshots fall back to seq (pre-fix behavior).
    const baseSeq = snapshotDoc ? (snapshotDoc.floorSeq ?? snapshotDoc.seq) : 0;
    const includeSnapshot = !(options.sinceSeq !== undefined && options.sinceSeq >= baseSeq);
    const fromSeq = includeSnapshot ? baseSeq : options.sinceSeq!;

    const rows: any[] = await DocumentUpdateModel.find({
      documentId, sessionDid, updateType: { $ne: "snapshot" }, seq: { $gt: fromSeq },
    }).sort({ seq: 1 }).lean();

    const updates: DocumentUpdate[] = [];
    const snapshotBytes = includeSnapshot && snapshotDoc ? (snapshotDoc.data?.length ?? 0) : 0;
    let bytes = snapshotBytes;
    let hasMore = false;
    let nextSeq: number | null = null;
    if (snapshotBytes >= maxBytes) {
      // A snapshot that alone fills the page budget is served by itself — the loop below
      // force-includes one update per page, which here could push the emit past the socket
      // buffer. The cursor resumes at the floor, where the snapshot is no longer included.
      if (rows.length > 0) { hasMore = true; nextSeq = fromSeq; }
    } else
    for (const r of rows) {
      bytes += r.data?.length ?? 0;
      if (updates.length > 0 && bytes > maxBytes) { hasMore = true; nextSeq = updates[updates.length - 1].seq!; break; }
      updates.push({ id: r._id, documentId: r.documentId, seq: r.seq, data: r.data, updateType: r.updateType, committed: r.committed, commitCid: r.commitCid, createdAt: r.createdAt, sessionDid: r.sessionDid, publishedMarker: r.publishedMarker });
    }

    const snapshot: DocumentUpdate | null = includeSnapshot && snapshotDoc
      ? { id: snapshotDoc._id, documentId: snapshotDoc.documentId, seq: snapshotDoc.seq, data: snapshotDoc.data, updateType: "snapshot", committed: false, commitCid: null, createdAt: snapshotDoc.createdAt, sessionDid: snapshotDoc.sessionDid, publishedMarker: snapshotDoc.publishedMarker, floorSeq: snapshotDoc.floorSeq ?? null }
      : null;

    return { snapshot, updates, nextSeq, hasMore };
  }

  // Document metadata (pre-publish recovery: owner-authored editLock + title)
  async upsertDocumentMeta(meta: {
    documentId: string;
    sessionDid: string;
    ownerDid: string | null;
    ownerIdentityDid: string | null;
    portalAddress: string | null;
    editLock: string | null;
    title: string | null;
  }): Promise<void> {
    await DocumentMetaModel.findOneAndUpdate(
      { _id: meta.documentId },
      {
        $setOnInsert: {
          ownerDid: meta.ownerDid,
          ownerIdentityDid: meta.ownerIdentityDid,
          portalAddress: meta.portalAddress,
        },
        $set: {
          sessionDid: meta.sessionDid,
          editLock: meta.editLock,
          title: meta.title,
          updatedAt: Date.now(),
        },
      },
      { upsert: true, new: true, writeConcern: { w: "majority", j: true } }
    );
  }

  // First-writer-immutable document->owner binding (see docs/architecture/edit-permission.md).
  // The pin closes C1: a colliding appFileId minted on another portal can never rebind an
  // already-pinned documentId. Returns the EFFECTIVE portalAddress so the caller can reject
  // a mismatch atomically (no read-modify-write race). Two steps so a LEGACY row that predates
  // the pin (portalAddress null/absent) gets backfilled instead of locking its real owner out —
  // a filter-guarded upsert would dup-key on an already-pinned _id, so the ensure-then-backfill
  // split is deliberate. Mirrors session-manager.fillOwnerIdentityDidIfAbsent.
  async pinDocumentPortalIfAbsent(p: {
    documentId: string;
    portalAddress: string;
    ownerDid: string | null;
    ownerIdentityDid: string | null;
    sessionDid: string;
  }): Promise<{ portalAddress: string | null }> {
    // 1. Ensure the row exists; pin all binding fields on INSERT only.
    await DocumentMetaModel.findOneAndUpdate(
      { _id: p.documentId },
      {
        $setOnInsert: {
          portalAddress: p.portalAddress,
          ownerDid: p.ownerDid,
          ownerIdentityDid: p.ownerIdentityDid,
          sessionDid: p.sessionDid,
          updatedAt: Date.now(),
          isPublished: false,
        },
      },
      { upsert: true, writeConcern: { w: "majority", j: true } }
    );
    // 2. Backfill a legacy null/absent portal — never overwrites an existing real pin.
    await DocumentMetaModel.updateOne(
      { _id: p.documentId, $or: [{ portalAddress: null }, { portalAddress: { $exists: false } }] },
      { $set: { portalAddress: p.portalAddress } }
    );
    // 3. Read the effective pin.
    const doc: any = await DocumentMetaModel.findById(p.documentId).select("portalAddress").lean();
    return { portalAddress: doc?.portalAddress ?? null };
  }

  async getDocumentMeta(
    documentId: string
  ): Promise<{ editLock: string | null; title: string | null } | null> {
    const meta: any = await DocumentMetaModel.findById(documentId).select("editLock title").lean();
    if (!meta) return null;
    return { editLock: meta.editLock ?? null, title: meta.title ?? null };
  }

  async setMinEditEpoch(documentId: string, epoch: number): Promise<void> {
    await DocumentEditEpochModel.findOneAndUpdate(
      { _id: documentId },
      { $max: { minEditEpoch: epoch } },
      { upsert: true }
    );
  }

  async getMinEditEpoch(documentId: string): Promise<number> {
    const row: any = await DocumentEditEpochModel.findById(documentId).lean();
    return row?.minEditEpoch ?? 0;
  }

  // Record the epoch each evicted handle was removed at (monotonic $max, so a re-eviction only
  // raises it). Consulted by the LIVE per-actor re-check — see isStillAdmitted.
  async setEvictedHandles(documentId: string, handles: string[], epoch: number): Promise<void> {
    const update: Record<string, number> = {};
    for (const h of handles) update[`evictedHandles.${h}`] = epoch;
    if (Object.keys(update).length === 0) return;
    await DocumentEditEpochModel.findOneAndUpdate(
      { _id: documentId },
      { $max: update },
      { upsert: true }
    );
  }

  // The epoch a specific handle was evicted at, or undefined if it was never evicted. The LIVE
  // re-check kicks a socket iff its admitted editEpoch is below this — never a non-evicted handle.
  async getEvictedHandleEpoch(documentId: string, handle: string): Promise<number | undefined> {
    const row: any = await DocumentEditEpochModel.findById(documentId).lean();
    const v = row?.evictedHandles?.[handle];
    return typeof v === "number" ? v : undefined;
  }

  // Discovery: docs bound to the proven owner (identity DID or portal owner DID) — recovery for a wiped device.
  async listDocumentsForOwner(
    by: { ownerIdentityDid?: string; ownerDid?: string }
  ): Promise<Array<{ documentId: string; editLock: string | null; title: string | null }>> {
    const filter: Record<string, any> = {};
    if (by.ownerIdentityDid) filter.ownerIdentityDid = by.ownerIdentityDid;
    else if (by.ownerDid) filter.ownerDid = by.ownerDid;
    else return [];
    // Published docs are discovered via the indexer; the collab server only lists
    // unpublished durable docs (the publish reconciler flips this flag).
    filter.isPublished = { $ne: true };

    const metas: any[] = await DocumentMetaModel.find(filter).select("editLock title").lean();
    return metas.map((m) => ({
      documentId: m._id,
      editLock: m.editLock ?? null,
      title: m.title ?? null,
    }));
  }

  // Publish-reconciler candidate set: unpublished durable docs that have a portal to
  // resolve on-chain. Rows without a portalAddress can't be checked, so they are skipped.
  async listUnpublishedMetaRefs(
    limit: number
  ): Promise<Array<{ documentId: string; portalAddress: string }>> {
    const rows: any[] = await DocumentMetaModel.find({
      isPublished: { $ne: true },
      portalAddress: { $ne: null },
    })
      .select("portalAddress")
      .limit(limit)
      .lean();
    return rows.map((r) => ({ documentId: r._id, portalAddress: r.portalAddress }));
  }

  async markDocumentsPublished(
    docs: Array<{ documentId: string; fileId: string }>
  ): Promise<void> {
    if (docs.length === 0) return;
    // Per-doc onChainFileId, so a single updateMany won't do — one updateOne each.
    await DocumentMetaModel.bulkWrite(
      docs.map((d) => ({
        updateOne: {
          filter: { _id: d.documentId },
          update: { $set: { isPublished: true, onChainFileId: d.fileId } },
        },
      }))
    );
  }

  /** Open existence probe: lets the client distinguish "created but not yet
   *  published" (meta row exists from the owner's session) from a real 404. */
  async getShareContext(
    documentId: string
  ): Promise<{ exists: boolean; isPublished: boolean }> {
    const meta: any = await DocumentMetaModel.findById(documentId)
      .select("isPublished")
      .lean();
    if (!meta) return { exists: false, isPublished: false };
    return {
      exists: true,
      isPublished: meta.isPublished === true,
    };
  }

  // Commit management
  async createCommit(commit: DocumentCommit): Promise<DocumentCommit> {
    try {
      const mongoCommit = new DocumentCommitModel({
        _id: commit.id,
        documentId: commit.documentId,

        cid: commit.cid,
        updates: commit.updates,
        createdAt: commit.createdAt,
        sessionDid: commit.sessionDid,
        appType: commit.appType,
      });

      await mongoCommit.save();

      // Mark associated updates as committed
      await this.markUpdatesAsCommitted(commit.updates, commit.cid, commit.documentId);

      return commit;
    } catch (error) {
      console.error("Error creating commit:", error);
      throw error;
    }
  }

  async getCommit(commitId: string): Promise<DocumentCommit | undefined> {
    try {
      const commit = await DocumentCommitModel.findById(commitId);
      if (!commit) return undefined;

      return {
        id: commit._id,
        documentId: commit.documentId,
        cid: commit.cid,
        updates: commit.updates,
        createdAt: commit.createdAt,
        sessionDid: commit.sessionDid,
      };
    } catch (error) {
      console.error("Error getting commit:", error);
      return undefined;
    }
  }

  async getCommitsByDocument(
    filters: { documentId: string; sessionDid: string },
    options: {
      limit?: number;
      offset?: number;
      sort?: "asc" | "desc";
    } = {}
  ): Promise<DocumentCommit[]> {
    try {
      let query = DocumentCommitModel.find(filters);

      // Sort by creation time
      const sortOrder = options.sort === "desc" ? -1 : 1;
      query = query.sort({ createdAt: sortOrder });

      // Apply pagination
      if (options.offset) {
        query = query.skip(options.offset);
      }
      if (options.limit) {
        query = query.limit(options.limit);
      }

      const commits = await query.exec();

      return commits.map((commit) => ({
        id: commit._id,
        documentId: commit.documentId,
        cid: commit.cid,
        updates: commit.updates,
        createdAt: commit.createdAt,
        sessionDid: commit.sessionDid,
      }));
    } catch (error) {
      console.error("Error getting commits by document:", error);
      return [];
    }
  }

  async countUpdatesByDocument(
    filters: { documentId: string; sessionDid: string },
    options: { committed?: boolean } = {}
  ): Promise<number> {
    try {
      const query: Record<string, any> = { ...filters };
      if (options.committed !== undefined) {
        query.committed = options.committed;
      }
      return await DocumentUpdateModel.countDocuments(query);
    } catch (error) {
      console.error("Error counting updates:", error);
      return 0;
    }
  }

  async countCommitsByDocument(
    filters: { documentId: string; sessionDid: string }
  ): Promise<number> {
    try {
      return await DocumentCommitModel.countDocuments(filters);
    } catch (error) {
      console.error("Error counting commits:", error);
      return 0;
    }
  }

  // Statistics
  async getStats() {
    try {
      const [updates, commits] = await Promise.all([
        DocumentUpdateModel.countDocuments(),
        DocumentCommitModel.countDocuments(),
      ]);

      return {
        updates,
        commits,
      };
    } catch (error) {
      console.error("Error getting stats:", error);
      return {
        updates: 0,
        commits: 0,
      };
    }
  }

  // Owner-only permanent delete: wipes every collection scoped to this document.
  async purgeDocument(documentId: string): Promise<void> {
    await Promise.all([
      DocumentUpdateModel.deleteMany({ documentId }),
      DocumentCommitModel.deleteMany({ documentId }),
      DocumentMetaModel.deleteOne({ _id: documentId }),
      SessionModel.deleteMany({ documentId }),
      CounterModel.deleteOne({ _id: documentId }),
      DocumentMirrorModel.deleteMany({ documentId }),
      DocumentEditEpochModel.deleteOne({ _id: documentId }),
    ]);
  }

  // Reversible tombstone driven by the on-chain DeletedFile webhook (see
  // docs/architecture/edit-permission.md). Idempotent: a second call against an
  // already-tombstoned doc still returns true instead of erroring.
  async tombstoneDocument(documentId: string, reason: string): Promise<boolean> {
    const res = await DocumentMetaModel.updateOne(
      { _id: documentId, tombstonedAt: null },
      { $set: { tombstonedAt: Date.now(), tombstoneReason: reason } }
    );
    if (res.matchedCount > 0) return true;
    const existing: any = await DocumentMetaModel.findById(documentId).select("tombstonedAt").lean();
    return !!existing?.tombstonedAt;
  }

  async isTombstoned(documentId: string): Promise<boolean> {
    const m: any = await DocumentMetaModel.findById(documentId).select("tombstonedAt").lean();
    return !!m?.tombstonedAt;
  }

  // Grace-window irreversible purge. Reuses the existing collection deletes.
  async purgeTombstonedBefore(cutoffMs: number, batchSize: number): Promise<string[]> {
    const rows: any[] = await DocumentMetaModel.find({ tombstonedAt: { $ne: null, $lte: cutoffMs } })
      .select("_id")
      .limit(batchSize)
      .lean();
    const ids = rows.map((r) => String(r._id));
    for (const id of ids) await this.purgeDocument(id);
    return ids;
  }

  // Conservative orphan GC: terminated ddoc streams with no editLock and no snapshot row.
  // A real draft always has an editLock or a snapshot, so it is never swept.
  async collectOrphans(graceMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - graceMs);
    const terminated: any[] = await SessionModel.find({
      appType: "ddoc", state: "terminated", createdAt: { $lt: cutoff },
    }).lean();

    let purged = 0;
    for (const s of terminated) {
      // Pre-durable sessions (insert-only portalAddress key absent) predate the
      // editLock/snapshot invariant this sweep relies on — never sweep them.
      if (!Object.prototype.hasOwnProperty.call(s, "portalAddress")) continue;
      const meta: any = await DocumentMetaModel.findById(s.documentId).lean();
      if (meta?.editLock) continue; // real draft — never sweep
      const snap: any = await DocumentUpdateModel.findOne({ documentId: s.documentId, updateType: "snapshot" }).sort({ seq: -1 }).lean();
      if (snap) continue; // has a hydration base — never sweep
      const legacy: any = await DocumentUpdateModel.findOne({ documentId: s.documentId, seq: { $exists: false } }).select("_id").lean();
      if (legacy) continue; // pre-durable rows awaiting seq backfill — never sweep
      await DocumentUpdateModel.deleteMany({ documentId: s.documentId });
      await SessionModel.deleteMany({ documentId: s.documentId });
      await CounterModel.deleteOne({ _id: s.documentId });
      purged++;
    }
    return purged;
  }

  // Clear all data (useful for testing)
  async clear() {
    try {
      await Promise.all([DocumentUpdateModel.deleteMany({}), DocumentCommitModel.deleteMany({})]);
    } catch (error) {
      console.error("Error clearing data:", error);
      throw error;
    }
  }
}

export const mongodbStore = new MongoDBStore();
