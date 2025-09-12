import { WebSocket } from "ws";

export interface DocumentUpdate {
  id: string;
  documentId: string;
  userId: string;
  data: string; // encrypted Y.js update
  updateType: string;
  committed: boolean;
  commitCid: string | null;
  createdAt: number;
}

export interface DocumentCommit {
  id: string;
  documentId: string;
  userId: string;
  cid: string; // IPFS hash
  updates: string[]; // list of update IDs included in this commit
  createdAt: number;
}

export interface WebSocketMessage {
  cmd: string;
  args: Record<string, any>;
  seqId: string;
}

export interface WebSocketResponse {
  status: boolean;
  statusCode: number;
  seqId: string | null;
  is_handshake_response: boolean;
  data?: Record<string, any>;
  err?: string;
  err_detail?: Record<string, any> | null;
}

export interface WebSocketEvent {
  type: string;
  event_type: string;
  event: {
    data: any;
    roomId: string;
  };
}

export interface AuthenticatedWebSocket extends WebSocket {
  userId?: string;
  username?: string;
  documentId?: string;
  role?: "owner" | "editor";
  authenticated?: boolean;
  clientId?: string;
}

export interface IPFSUploadResponse {
  ipfsUrl: string;
  ipfsHash: string;
  ipfsStorage: string;
  cachedUrl: string;
  fileSize: number;
  mimetype: string;
}

export interface UCANPayload {
  aud: string; // audience (server DID)
  iss: string; // issuer (client DID)
  capabilities: Array<{
    with: {
      scheme: string;
      hierPart: string;
    };
    can: {
      namespace: string;
      segments: string[];
    };
  }>;
}

export interface DatabaseConfig {
  uri: string; // MongoDB connection string
}

export interface ServerConfig {
  port: number;
  host: string;
  corsOrigins: string[];
  database: DatabaseConfig;
  auth: {
    serverDid: string;
    serverKeyPair?: any;
  };
  rateLimit: {
    windowMs: number;
    max: number;
  };
  rpcURL: string;
  wsURL: string;
}
