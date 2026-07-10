import mongoose, { Schema, Document as MongooseDocument } from "mongoose";

interface ICounter extends MongooseDocument {
  _id: string; // documentId
  seq: number;
}

const CounterSchema = new Schema<ICounter>({
  _id: { type: String, required: true },
  seq: { type: Number, required: true, default: 0 },
});

export const CounterModel = mongoose.model<ICounter>("Counter", CounterSchema);
export type { ICounter };
