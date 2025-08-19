import mongoose, { Schema, Document as MongooseDocument } from "mongoose";

// Update Schema
interface IDocumentUpdate extends MongooseDocument {
  _id: string;
  document_id: string;
  user_id: string;
  data: string;
  update_type: string;
  committed: boolean;
  commit_cid: string | null;
  created_at: number;
}

const DocumentUpdateSchema = new Schema<IDocumentUpdate>({
  _id: { type: String, required: true },
  document_id: { type: String, required: true, index: true },
  user_id: { type: String, required: true },
  data: { type: String, required: true },
  update_type: { type: String, required: true },
  committed: { type: Boolean, default: false, index: true },
  commit_cid: { type: String, default: null },
  created_at: { type: Number, required: true, index: true },
});

// Compound indexes for efficient queries
DocumentUpdateSchema.index({ document_id: 1, created_at: 1 });
DocumentUpdateSchema.index({ document_id: 1, committed: 1, created_at: 1 });

// Create Model
export const DocumentUpdateModel = mongoose.model<IDocumentUpdate>(
  "DocumentUpdate",
  DocumentUpdateSchema
);

// Export interface for type checking
export type { IDocumentUpdate };
