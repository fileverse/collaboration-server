import mongoose, { Schema, Document as MongooseDocument } from "mongoose";

// Commit Schema
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

// Compound index for efficient queries
DocumentCommitSchema.index({ documentId: 1, createdAt: 1 });

// Create Model
export const DocumentCommitModel = mongoose.model<IDocumentCommit>(
  "DocumentCommit",
  DocumentCommitSchema
);

// Export interface for type checking
export type { IDocumentCommit };
