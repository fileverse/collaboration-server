import { Server, Socket } from "socket.io";

// ***************************************
// Domain Models (unchanged)
// ***************************************

export interface DocumentUpdate {
  id: string;
  documentId: string;
  data: string; // encrypted Y.js update
  updateType: string;
  committed: boolean;
  commitCid: string | null;
  createdAt: number;
  sessionDid: string;
}

export interface DocumentCommit {
  id: string;
  documentId: string;
  cid: string; // IPFS hash
  updates: string[]; // list of update IDs included in this commit
  createdAt: number;
  sessionDid: string;
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

// ***************************************
// Socket.IO Acknowledgement Response
// ***************************************

export interface AckResponse<T = Record<string, any>> {
  status: boolean;
  statusCode: number;
  data?: T;
  error?: string;
}

// ***************************************
// Client → Server Event Payload Types
// ***************************************

export interface AuthArgs {
  documentId: string;
  sessionDid: string;
  collaborationToken: string;
  ownerToken?: string;
  ownerAddress?: string;
  contractAddress?: string;
  roomInfo?: string;
}

export interface AuthResponseData {
  message: string;
  role: "owner" | "editor";
  sessionType: "new" | "existing";
  roomInfo?: string;
}

export interface DocumentUpdateArgs {
  documentId?: string;
  data: string;
  collaborationToken: string;
}

export interface DocumentUpdateResponseData {
  id: string;
  documentId: string;
  data: string;
  updateType: string;
  commitCid: string | null;
  createdAt: number;
}

export interface DocumentCommitArgs {
  documentId?: string;
  updates: string[];
  cid: string;
  ownerToken: string;
  ownerAddress: string;
  contractAddress: string;
}

export interface DocumentCommitResponseData {
  cid: string;
  createdAt: number;
  documentId: string;
  updates: string[];
}

export interface CommitHistoryArgs {
  documentId?: string;
  offset?: number;
  limit?: number;
  sort?: "asc" | "desc";
}

export interface UpdateHistoryArgs {
  documentId?: string;
  offset?: number;
  limit?: number;
  sort?: "asc" | "desc";
  filters?: { committed?: boolean };
}

export interface PeersListArgs {
  documentId?: string;
}

export interface AwarenessArgs {
  documentId?: string;
  data: any;
  collaborationToken?: string;
}

export interface TerminateSessionArgs {
  documentId: string;
  sessionDid: string;
  ownerToken: string;
  ownerAddress: string;
  contractAddress: string;
}

export interface CommitHistoryResponseData {
  history: DocumentCommit[];
  total: number;
}

export interface UpdateHistoryResponseData {
  history: DocumentUpdate[];
  total: number;
}

export interface PeersListResponseData {
  peers: string[];
}

export interface MessageResponseData {
  message: string;
}

// ***************************************
// Server → Client Event Payload Types
// ***************************************

export interface HandshakePayload {
  server_did: string;
  message: string;
}

export interface ContentUpdatePayload {
  id: string;
  data: string;
  createdAt: number;
  roomId: string;
}

export interface AwarenessUpdatePayload {
  data: any;
  roomId: string;
}

export interface MembershipChangePayload {
  action: "user_joined" | "user_left";
  user: { role: "owner" | "editor" };
  roomId: string;
}

export interface SessionTerminatedPayload {
  roomId: string;
}

// ***************************************
// Socket.IO Typed Event Maps
// ***************************************

type ClientEventHandler<Args, Data> = (
  args: Args,
  callback?: (response: AckResponse<Data>) => void
) => void;

export interface ClientToServerEvents {
  "/auth": ClientEventHandler<AuthArgs, AuthResponseData>;
  "/documents/update": ClientEventHandler<DocumentUpdateArgs, DocumentUpdateResponseData>;
  "/documents/commit": ClientEventHandler<DocumentCommitArgs, DocumentCommitResponseData>;
  "/documents/commit/history": ClientEventHandler<CommitHistoryArgs, CommitHistoryResponseData>;
  "/documents/update/history": ClientEventHandler<UpdateHistoryArgs, UpdateHistoryResponseData>;
  "/documents/peers/list": ClientEventHandler<PeersListArgs, PeersListResponseData>;
  "/documents/awareness": ClientEventHandler<AwarenessArgs, MessageResponseData>;
  "/documents/terminate": ClientEventHandler<TerminateSessionArgs, MessageResponseData>;
}

export interface ServerToClientEvents {
  "/server/handshake": (data: HandshakePayload) => void;
  "/document/content_update": (data: ContentUpdatePayload) => void;
  "/document/awareness_update": (data: AwarenessUpdatePayload) => void;
  "/room/membership_change": (data: MembershipChangePayload) => void;
  "/session/terminated": (data: SessionTerminatedPayload) => void;
}

export interface InterServerEvents {
  ping: () => void;
}

export interface SocketData {
  documentId: string;
  sessionDid: string;
  role: "owner" | "editor";
  authenticated: boolean;
}

// ***************************************
// Socket.IO Type Aliases
// ***************************************

export type AppServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export type AppSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

// ***************************************
// Configuration Types
// ***************************************

export interface DatabaseConfig {
  uri: string; // MongoDB connection string
}

export interface RedisConfig {
  url: string;
  enabled: boolean;
}

export interface SocketIOConfig {
  pingInterval: number;
  pingTimeout: number;
  maxHttpBufferSize: number;
}

export interface ServerConfig {
  port: number;
  host: string;
  corsOrigins: string[];
  database: DatabaseConfig;
  redis: RedisConfig;
  socketio: SocketIOConfig;
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
  nodeEnv: string;
}