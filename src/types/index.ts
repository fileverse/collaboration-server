import { WebSocket } from "ws";

export interface RoomMember {
  user_id: string;
  username: string;
  role: "owner" | "editor";
  client_id?: string;
  joined_at: number;
}

export interface DocumentUpdate {
  id: string;
  document_id: string;
  agent_id: string;
  data: string; // encrypted Y.js update
  update_type: string;
  committed: boolean;
  commit_cid: string | null;
  update_snapshot_ref: string | null;
  created_at: number;
}

export interface DocumentCommit {
  id: string;
  document_id: string;
  agent_id: string;
  cid: string; // IPFS hash
  data: string | null; // encrypted document state
  updates: string[]; // list of update IDs included in this commit
  created_at: number;
}

export interface WebSocketMessage {
  cmd: string;
  args: Record<string, any>;
  seq_id: string;
}

export interface WebSocketResponse {
  status: boolean;
  status_code: number;
  seq_id: string | null;
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
  user_id?: string;
  username?: string;
  document_id?: string;
  role?: "owner" | "editor";
  authenticated?: boolean;
  client_id?: string;
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
  type: "sqlite" | "postgres" | "mysql";
  filename?: string; // for SQLite
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
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
}
