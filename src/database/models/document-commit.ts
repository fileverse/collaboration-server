import mongoose, { Schema, Document as MongooseDocument } from "mongoose";

interface IDocumentCommit extends MongooseDocument {
  _id: string;
  documentId: string;
  userId: string;
  cid: string;
  data: string | null;
  updates: string[];
  createdAt: number;
}

const DocumentCommitSchema = new Schema<IDocumentCommit>({
  _id: { type: String, required: true },
  documentId: { type: String, required: true, index: true },
  userId: { type: String, required: true },
  cid: { type: String, required: true },
  data: { type: String, default: null },
  updates: [{ type: String }],
  createdAt: { type: Number, required: true, index: true },
});

DocumentCommitSchema.index({ documentId: 1, createdAt: 1 });

export const DocumentCommitModel = mongoose.model<IDocumentCommit>(
  "DocumentCommit",
  DocumentCommitSchema
);

export type { IDocumentCommit };
