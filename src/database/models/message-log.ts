import mongoose, { Schema, Document as MongooseDocument } from "mongoose";

export interface IMessageLog extends MongooseDocument {
  _id: string; 
  timestamp: number;
  connectionId: string;
  message: {
    cmd?: string
    args?: any
    seqId?: string
  }
  direction: 'inbound' | 'outbound' | 'broadcast';
  protocol: 'websocket' | 'socketio';
  context: {
    documentId?: string;
    sessionDid?: string;
    role?: 'owner' | 'editor';
    authenticated: boolean;
  }
  response?: {
    status: boolean;
    statusCode: number;
    latencyMs: number;
  }
  dynoId: string;
}

const MessageLogSchema = new Schema({
  _id: { type: String, required: true },
  timestamp: { type: Number, required: true, index: true },
  connectionId: { type: String, required: true, index: true },
  direction: {
    type: String,
    enum: ['inbound', 'outbound', 'broadcast'],
    required: true,
  },
  protocol: {
    type: String,
    enum: ['websocket', 'socketio'],
    required: true,
  },
  message: {
    cmd: { type: String },
    args: { type: Schema.Types.Mixed },
    seqId: { type: String },
  }, 
  context: {
    documentId: { type: String },
    sessionDid: { type: String },
    role: {
      type: String,
      enum: ['owner', 'editor'],
    },
    authenticated: { type: Boolean, required: true },
  },
  response: {
    status: { type: Boolean },
    statusCode: { type: Number },
    latencyMs: { type: Number },
  },
  dynoId: { type: String, required: true },
});

// Indexes for querying replay scenarios
MessageLogSchema.index({ timestamp: 1 }, { background: true });
MessageLogSchema.index({ connectionId: 1, timestamp: 1 }, { background: true });
MessageLogSchema.index({ 'context.documentId': 1, timestamp: 1 }, { background: true });
MessageLogSchema.index({ 'context.sessionDid': 1, timestamp: 1 }, { background: true });

export const MessageLogModel = mongoose.model<IMessageLog>("MessageLog", MessageLogSchema);
