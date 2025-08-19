import mongoose, { Schema, Document as MongooseDocument } from "mongoose";

// Commit Schema
interface IDocumentCommit extends MongooseDocument {
  _id: string;
  document_id: string;
  user_id: string;
  cid: string;
  data: string | null;
  updates: string[];
  created_at: number;
}

const DocumentCommitSchema = new Schema<IDocumentCommit>({
  _id: { type: String, required: true },
  document_id: { type: String, required: true, index: true },
  user_id: { type: String, required: true },
  cid: { type: String, required: true },
  data: { type: String, default: null },
  updates: [{ type: String }],
  created_at: { type: Number, required: true, index: true },
});

// Compound index for efficient queries
DocumentCommitSchema.index({ document_id: 1, created_at: 1 });

// Create Model
export const DocumentCommitModel = mongoose.model<IDocumentCommit>(
  "DocumentCommit",
  DocumentCommitSchema
);

// Export interface for type checking
export type { IDocumentCommit };
