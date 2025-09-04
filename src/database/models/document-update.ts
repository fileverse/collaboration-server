import mongoose, { Schema, Document as MongooseDocument } from "mongoose";

interface IDocumentUpdate extends MongooseDocument {
  _id: string;
  documentId: string;

  data: string;
  updateType: string;
  committed: boolean;
  commitCid: string | null;
  createdAt: number;
  sessionDid: string;
}

const DocumentUpdateSchema = new Schema<IDocumentUpdate>({
  _id: { type: String, required: true },
  documentId: { type: String, required: true, index: true },

  data: { type: String, required: true },
  updateType: { type: String, required: true },
  committed: { type: Boolean, default: false, index: true },
  commitCid: { type: String, default: null },
  createdAt: { type: Number, required: true, index: true },
  sessionDid: { type: String, required: true },
});

DocumentUpdateSchema.index(
  { documentId: 1, createdAt: 1, sessionDid: 1 },
  {
    partialFilterExpression: { committed: false },
  }
);
DocumentUpdateSchema.index({ documentId: 1, committed: 1, createdAt: 1, sessionDid: 1 });

export const DocumentUpdateModel = mongoose.model<IDocumentUpdate>(
  "DocumentUpdate",
  DocumentUpdateSchema
);

export type { IDocumentUpdate };
