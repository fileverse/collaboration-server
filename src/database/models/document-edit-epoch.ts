import mongoose, { Schema, Document as MongooseDocument } from "mongoose";

// Per-document edit-admission floor. A gp-actor editUcan whose `epoch` fact is below this
// is refused at JOIN (offline revocation — replaces the runtime edit-bound poll). Bumped by
// the rotation / evict path. See docs/architecture/gp-semaphore.md.
//
// `evictedHandles` is the per-actor LIVE re-check: handle -> the epoch it was evicted at. An
// already-admitted socket is kicked iff ITS handle is here at an epoch above the one it joined
// under. This is the offline dual of the old per-handle edit-bound poll: a survivor's handle is
// never listed (never kicked), a removed actor's is (kicked), a re-added actor joins at a higher
// epoch (not kicked). Keyed by the poseidon editHandle (a decimal string — safe as a field key).
interface IDocumentEditEpoch extends MongooseDocument {
  _id: string; // documentId
  minEditEpoch: number;
  evictedHandles?: Record<string, number>;
}

const DocumentEditEpochSchema = new Schema<IDocumentEditEpoch>({
  _id: { type: String, required: true },
  minEditEpoch: { type: Number, required: true, default: 0 },
  evictedHandles: { type: Schema.Types.Mixed, default: undefined },
});

export const DocumentEditEpochModel = mongoose.model<IDocumentEditEpoch>(
  "DocumentEditEpoch",
  DocumentEditEpochSchema
);
export type { IDocumentEditEpoch };
