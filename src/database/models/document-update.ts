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
  appType: "ddoc" | "dsheet";
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
  // Which Fileverse app produced this update. Absent ⇒ "ddoc" (legacy).
  appType: { type: String, enum: ["ddoc", "dsheet"], default: "ddoc" },
});

DocumentUpdateSchema.index({ documentId: 1, committed: 1, createdAt: 1 }, { background: true });

DocumentUpdateSchema.index(
  { documentId: 1, createdAt: 1 },
  {
    partialFilterExpression: { committed: false },
    background: true,
  }
);

DocumentUpdateSchema.index({ documentId: 1, sessionDid: 1 }, { background: true });

// Supports per-app lifecycle/analytics queries (e.g. "all dsheet updates").
DocumentUpdateSchema.index({ appType: 1, createdAt: 1 }, { background: true });

export const DocumentUpdateModel = mongoose.model<IDocumentUpdate>(
  "DocumentUpdate",
  DocumentUpdateSchema
);

export type { IDocumentUpdate };
