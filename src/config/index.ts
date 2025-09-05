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

  auth: {
    serverDid: process.env.SERVER_DID || "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "900000"), // 15 minutes
    max: parseInt(process.env.RATE_LIMIT_MAX || "100"), // limit each IP to 100 requests per windowMs
  },
  rpcURL: process.env.RPC_URL || "https://rpc.ankr.com/eth",
  redisURL: process.env.REDISCLOUD_URL || "redis://localhost:6379",
};
