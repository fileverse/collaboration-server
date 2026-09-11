import mongoose, { Schema, Document as MongooseDocument } from "mongoose";

// Per-document wire-format lock. A row means the document is locked to XChaCha; no row
// means ECIES. Separate from DocumentMeta on purpose: that row is created by the owner's
// meta upload with $setOnInsert fields, and an auth-time upsert would strand them.
interface IDocumentWireFormat extends MongooseDocument {
  _id: string; // documentId
  wireFormat: "xchacha";
  lockedAt: number;
}

const DocumentWireFormatSchema = new Schema<IDocumentWireFormat>({
  _id: { type: String, required: true },
  wireFormat: { type: String, enum: ["xchacha"], required: true },
  lockedAt: { type: Number, required: true },
});

export const DocumentWireFormatModel = mongoose.model<IDocumentWireFormat>(
  "DocumentWireFormat",
  DocumentWireFormatSchema
);
export type { IDocumentWireFormat };
