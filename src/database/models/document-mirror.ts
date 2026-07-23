import mongoose, { Schema, Document as MongooseDocument } from "mongoose";

// The VIEW plane: fileKey-encrypted full-state snapshots (published-artifact shape) that
// viewers read load-on-open. Separate from DocumentUpdate (roomKey durability lane): different
// key, open read, epoch-keyed. One row per (documentId, fileKeyEpoch), keep-latest.
interface IDocumentMirror extends MongooseDocument {
  documentId: string;
  fileKeyEpoch: number;
  data: string;
  createdAt: number;
  authorSessionDid: string;
}

const DocumentMirrorSchema = new Schema<IDocumentMirror>({
  documentId: { type: String, required: true },
  fileKeyEpoch: { type: Number, required: true },
  data: { type: String, required: true },
  createdAt: { type: Number, required: true },
  authorSessionDid: { type: String, required: true },
});

DocumentMirrorSchema.index({ documentId: 1, fileKeyEpoch: 1 }, { unique: true, background: true });

export const DocumentMirrorModel = mongoose.model<IDocumentMirror>("DocumentMirror", DocumentMirrorSchema);
export type { IDocumentMirror };
