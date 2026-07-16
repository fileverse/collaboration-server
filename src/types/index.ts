import { Server, Socket } from "socket.io";

// ***************************************
// Domain Models (unchanged)
// ***************************************

/**
 * Identifies which Fileverse app a document/session/update belongs to.
 * The collaboration server is shared between ddoc and dsheet.
 * Absent ⇒ "ddoc" (legacy: all data predating this field is ddoc).
 */
export type AppType = "ddoc" | "dsheet";

export interface DocumentUpdate {
  id: string;
  documentId: string;
  data: string; // encrypted Y.js update
  updateType: string;
  committed: boolean;
  commitCid: string | null;
  createdAt: number;
  sessionDid: string;
  appType?: AppType;
  seq?: number;
  publishedMarker?: string | null;
  // Snapshot rows only: the author's contiguous range-read floor. Hydration serves
  // seq > floorSeq (NOT > the snapshot's own seq) so a concurrent writer's update that
  // the snapshot author never applied is still re-served instead of orphaned.
  floorSeq?: number | null;
}

export interface DocumentCommit {
  id: string;
  documentId: string;
  cid: string; // IPFS hash
  updates: string[]; // list of update IDs included in this commit
  createdAt: number;
  sessionDid: string;
  appType?: AppType;
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
// Error Codes
// ***************************************

export enum ErrorCode {
  AUTH_TOKEN_MISSING = "AUTH_TOKEN_MISSING",
  AUTH_TOKEN_INVALID = "AUTH_TOKEN_INVALID",
  SESSION_NOT_FOUND = "SESSION_NOT_FOUND",
  SESSION_TERMINATED = "SESSION_TERMINATED",
  SESSION_DID_MISSING = "SESSION_DID_MISSING",
  DOCUMENT_ID_MISSING = "DOCUMENT_ID_MISSING",
  UPDATE_DATA_MISSING = "UPDATE_DATA_MISSING",
  COMMIT_UNAUTHORIZED = "COMMIT_UNAUTHORIZED",
  COMMIT_MISSING_DATA = "COMMIT_MISSING_DATA",
  INVALID_ADDRESS = "INVALID_ADDRESS",
  NOT_AUTHENTICATED = "NOT_AUTHENTICATED",
  APP_MISMATCH = "APP_MISMATCH",
  JOIN_DISABLED = "JOIN_DISABLED",
  EDIT_REVOKED = "EDIT_REVOKED",
  ROOM_NOT_ESTABLISHED = "ROOM_NOT_ESTABLISHED",
  DB_ERROR = "DB_ERROR",
  INTERNAL_ERROR = "INTERNAL_ERROR",
}

// ***************************************
// Socket.IO Acknowledgement Response
// ***************************************

export interface AckResponse<T = Record<string, any>> {
  status: boolean;
  statusCode: number;
  data?: T;
  error?: string;
  errorCode?: ErrorCode;
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
  appType?: AppType;
  ownerIdentityDid?: string;
  identityToken?: string;
  identityContractAddress?: string;
  editUcan?: string;
  actorHandle?: string;
  /** Privilege-reducing join mode (workspace member): the server must never create or
   *  bind a session for this connection, and the role is capped at editor. */
  joinOnly?: boolean;
}

export interface AuthResponseData {
  message: string;
  role: "owner" | "editor";
  sessionType: "new" | "existing";
  roomInfo?: string;
  /** Latest stored roomKey-encrypted title (DocumentMeta) — fresher than the
   *  session-frozen roomInfo blob after a mid-session rename. */
  title?: string | null;
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

export interface SnapshotArgs {
  documentId?: string;
  data: string;
  collaborationToken: string;
  publishedMarker?: string | null;
  // The author's contiguous range-read floor at authorship time — the seq up to which
  // this full-state snapshot is provably complete. Hydration cuts the tail here.
  floorSeq: number;
}

export interface MirrorSnapshotArgs {
  documentId?: string;
  data: string;
  fileKeyEpoch: number;
}

export interface DocumentMetaArgs {
  documentId?: string;
  editLock: string | null;
  title: string | null;
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
  sinceSeq?: number;
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
  snapshot: DocumentUpdate | null;
  nextSeq: number | null;
  hasMore: boolean;
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

export interface MetaUpdatePayload {
  roomId: string;
  /** roomKey-encrypted; the server never sees the plaintext title. */
  title: string | null;
}

export interface SessionTerminatedPayload {
  roomId: string;
}

export interface ServerErrorPayload {
  errorCode: ErrorCode;
  message: string;
  roomId: string;
}

// ***************************************
// Socket.IO Typed Event Maps
// ***************************************

type ClientEventHandler<Args, Data> = (
  args: Args,
  callback: (response: AckResponse<Data>) => void
) => void;

export interface ClientToServerEvents {
  "/auth": ClientEventHandler<AuthArgs, AuthResponseData>;
  "/documents/update": ClientEventHandler<DocumentUpdateArgs, DocumentUpdateResponseData>;
  "/documents/commit": ClientEventHandler<DocumentCommitArgs, DocumentCommitResponseData>;
  "/documents/commit/history": ClientEventHandler<CommitHistoryArgs, CommitHistoryResponseData>;
  "/documents/update/history": ClientEventHandler<UpdateHistoryArgs, UpdateHistoryResponseData>;
  "/documents/snapshot": ClientEventHandler<SnapshotArgs, { id: string; seq: number }>;
  "/documents/mirror-snapshot": ClientEventHandler<MirrorSnapshotArgs, { ok: true }>;
  "/documents/meta": ClientEventHandler<DocumentMetaArgs, { ok: true }>;
  "/documents/peers/list": ClientEventHandler<PeersListArgs, PeersListResponseData>;
  "/documents/awareness": ClientEventHandler<AwarenessArgs, MessageResponseData>;
  "/documents/terminate": ClientEventHandler<TerminateSessionArgs, MessageResponseData>;
}

export interface ServerToClientEvents {
  "/server/handshake": (data: HandshakePayload) => void;
  "/server/error": (data: ServerErrorPayload) => void;
  "/document/content_update": (data: ContentUpdatePayload) => void;
  "/document/awareness_update": (data: AwarenessUpdatePayload) => void;
  "/document/meta_update": (data: MetaUpdatePayload) => void;
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
  appType: AppType;
  rail?: "gp" | "workspace" | "public";
  railKind?: "gp-actor" | "gp-legacy" | "workspace" | "public";
  admittedEditGrantEpoch?: number;
  actorHandle?: string;
  actorIdentityDid?: string;
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
    legacyRoleFallback: boolean;
  };
  gate: {
    url: string | undefined;
    did: string | undefined;
  };
  rateLimit: {
    windowMs: number;
    max: number;
  };
  rpcURL: string;
  wsURL: string;
  nodeEnv: string;
  publishReconcile: {
    interval: string;
    batchSize: number;
  };
  agenda: {
    concurrency: number;
  };
}