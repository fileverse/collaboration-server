import mongoose, { Schema, Document as MongooseDocument } from "mongoose";

interface IDocumentMeta extends MongooseDocument {
  _id: string; // documentId
  sessionDid: string;
  ownerDid: string | null;
  ownerIdentityDid: string | null;
  portalAddress: string | null;
  editLock: string | null; // roomKey-wrapped
  title: string | null; // roomKey-encrypted
  updatedAt: number;
  isPublished: boolean; // set by the publish reconciler once the doc is on-chain
  onChainFileId: string | null; // on-chain fileId, captured by the reconciler at publish detection
  tombstonedAt: number | null; // set by the DeletedFile webhook; grace window runs from here
  tombstoneReason: string | null;
}

const DocumentMetaSchema = new Schema<IDocumentMeta>({
  _id: { type: String, required: true },
  sessionDid: { type: String, required: true },
  ownerDid: { type: String, default: null },
  ownerIdentityDid: { type: String, default: null },
  portalAddress: { type: String, default: null },
  editLock: { type: String, default: null },
  title: { type: String, default: null },
  updatedAt: { type: Number, required: true },
  isPublished: { type: Boolean, default: false },
  onChainFileId: { type: String, default: null },
  tombstonedAt: { type: Number, default: null },
  tombstoneReason: { type: String, default: null },
});

// Discovery: "all docs bound to this identity / portal owner" for list-my-documents.
// Compound with isPublished so both the (unpublished-only) list read and the
// reconciler's candidate scan are index-served.
DocumentMetaSchema.index({ ownerIdentityDid: 1, isPublished: 1 }, { background: true });
DocumentMetaSchema.index({ ownerDid: 1 }, { background: true });
// Grace-window sweep: docs eligible for irreversible purge (see docs/architecture/edit-permission.md).
DocumentMetaSchema.index({ tombstonedAt: 1 }, { background: true });

export const DocumentMetaModel = mongoose.model<IDocumentMeta>("DocumentMeta", DocumentMetaSchema);
export type { IDocumentMeta };
