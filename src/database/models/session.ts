import mongoose, { Schema, Document as MongooseDocument } from "mongoose";

export interface ISession extends MongooseDocument {
  documentId: string;
  sessionDid: string;
  ownerDid: string;
  createdAt: Date;
  state: "active" | "inactive" | "terminated";
  roomInfo: string;
  appType: "ddoc" | "dsheet";
  ownerIdentityDid: string | null;
  portalAddress: string | null;
  collabJoinEnabled?: boolean;
}

const SessionSchema = new Schema({
  documentId: { type: String, required: true },
  sessionDid: { type: String, required: true },
  ownerDid: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  state: { type: String, enum: ["active", "inactive", "terminated"], default: "active" },
  roomInfo: { type: String, default: null },
  // Which Fileverse app owns this session. Absent ⇒ "ddoc" (legacy).
  appType: { type: String, enum: ["ddoc", "dsheet"], default: "ddoc" },
  // R3 owner-identity binding: written once via $setOnInsert, never overwritten.
  ownerIdentityDid: { type: String, default: null },
  portalAddress: { type: String, default: null },
  collabJoinEnabled: { type: Boolean }, // intentionally no default
});

SessionSchema.index({ documentId: 1, createdAt: 1, sessionDid: 1 });

export const SessionModel = mongoose.model<ISession>("Session", SessionSchema);
