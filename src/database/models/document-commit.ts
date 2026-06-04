import mongoose, { Schema, Document as MongooseDocument } from "mongoose";

interface IDocumentCommit extends MongooseDocument {
  _id: string;
  documentId: string;

  cid: string;
  data: string | null;
  updates: string[];
  createdAt: number;
  sessionDid: string;
  appType: "ddoc" | "dsheet";
}

const DocumentCommitSchema = new Schema<IDocumentCommit>({
  _id: { type: String, required: true },
  documentId: { type: String, required: true, index: true },

  cid: { type: String, required: true },
  data: { type: String, default: null },
  updates: [{ type: String }],
  createdAt: { type: Number, required: true, index: true },
  sessionDid: { type: String, required: true },
  // Which Fileverse app produced this commit. Absent ⇒ "ddoc" (legacy).
  appType: { type: String, enum: ["ddoc", "dsheet"], default: "ddoc" },
});

DocumentCommitSchema.index({ documentId: 1, createdAt: -1 }, { background: true });

DocumentCommitSchema.index({ documentId: 1, sessionDid: 1 }, { background: true });

// Supports per-app lifecycle/analytics queries (e.g. "all dsheet commits").
DocumentCommitSchema.index({ appType: 1, createdAt: 1 }, { background: true });

export const DocumentCommitModel = mongoose.model<IDocumentCommit>(
  "DocumentCommit",
  DocumentCommitSchema
);

export type { IDocumentCommit };
