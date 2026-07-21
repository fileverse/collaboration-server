import mongoose, { Schema, Document as MongooseDocument } from "mongoose";

// Per-document edit-admission floor. A gp-actor editUcan whose `epoch` fact is below this
// is refused at JOIN (offline revocation — replaces the runtime edit-bound poll). Bumped by
// the rotation / evict path. See docs/architecture/gp-semaphore.md.
interface IDocumentEditEpoch extends MongooseDocument {
  _id: string; // documentId
  minEditEpoch: number;
}

const DocumentEditEpochSchema = new Schema<IDocumentEditEpoch>({
  _id: { type: String, required: true },
  minEditEpoch: { type: Number, required: true, default: 0 },
});

export const DocumentEditEpochModel = mongoose.model<IDocumentEditEpoch>(
  "DocumentEditEpoch",
  DocumentEditEpochSchema
);
export type { IDocumentEditEpoch };
