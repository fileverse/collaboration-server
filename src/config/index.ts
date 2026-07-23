import { ServerConfig } from "../types/index";
import dotenv from "dotenv";
dotenv.config();

export const config: ServerConfig = {
  port: parseInt(process.env.PORT || "5001"),
  host: process.env.HOST || "0.0.0.0",
  corsOrigins: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(",") : ["*"],

  database: {
    uri: process.env.MONGODB_URI || "mongodb://localhost:27017/collaboration",
  },

  redis: {
    url: process.env.REDISCLOUD_URL || "redis://localhost:6379",
    enabled: process.env.REDIS_ENABLED === "true",
  },

  socketio: {
    pingInterval: parseInt(process.env.SOCKETIO_PING_INTERVAL || "20000"),
    pingTimeout: parseInt(process.env.SOCKETIO_PING_TIMEOUT || "10000"),
    maxHttpBufferSize: parseInt(process.env.SOCKETIO_MAX_BUFFER || "10485760"), // 10MB
  },

  auth: {
    serverDid: process.env.SERVER_DID || "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "900000"), // 15 minutes
    max: parseInt(process.env.RATE_LIMIT_MAX || "100"),
  },
  rpcURL: process.env.RPC_URL || "https://rpc.ankr.com/eth",
  wsURL: process.env.WS_URL || "wss://0.0.0.0:5001",
  nodeEnv: process.env.NODE_ENV || "development",
  publishReconcile: {
    interval: process.env.PUBLISH_RECONCILE_INTERVAL || "15 minutes",
    batchSize: parseInt(process.env.PUBLISH_RECONCILE_BATCH || "500"),
  },
  deleteGrace: {
    windowMs: parseInt(process.env.DELETE_GRACE_WINDOW_MS || "2592000000"), // 30 days
    interval: process.env.DELETE_GRACE_INTERVAL || "1 hour",
    batchSize: parseInt(process.env.DELETE_GRACE_BATCH || "200"),
  },
  agenda: {
    concurrency: parseInt(process.env.AGENDA_DEFAULT_CONCURRENCY || "1"),
  },
  gate: {
    url: process.env.GATE_URL,
    did: process.env.GATE_DID,
  },
  webhook: {
    apiKey: process.env.COLLAB_WEBHOOK_API_KEY,
  },
};