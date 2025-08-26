import mongoose, { Schema, Document as MongooseDocument } from "mongoose";

export interface ISession extends MongooseDocument {
  documentId: string;
  collaborationDid: string;
  ownerDid: string;
  createdAt: Date;
  state: "active" | "terminated";
}

const SessionSchema = new Schema({
  documentId: { type: String, required: true },
  collaborationDid: { type: String, required: true },
  ownerDid: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  state: { type: String, enum: ["active", "inactive", "terminated"], default: "active" },
});

SessionSchema.index({ documentId: 1, createdAt: 1 });

export const SessionModel = mongoose.model<ISession>("Session", SessionSchema);
