import express from "express";
import mongoose from "mongoose";
import { Server } from "socket.io";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import { createServer } from "http";
import { config } from "./config";
import { authService } from "./services/auth";
import { registerEventHandlers, getRoomName } from "./services/socket-handlers";
import { authMiddleware } from "./services/auth-middleware";
import { sessionManager } from "./services/session-manager";
import { mongodbStore } from "./services/mongodb-store";
import { createRedisAdapter } from "./redis";
import { databaseService } from "./database";
import {
  createCollabJoinEnabledHandler,
  createWorkspaceEditTierHandler,
  createEvictEditActorsHandler,
  createEvictWorkspaceMemberHandler,
  createListMyDocumentsHandler,
  createDeleteDocumentHandler,
  createMirrorReadHandler,
  createShareContextHandler,
} from "./services/owner-op-routes";
import { createRotateSessionHandler } from "./services/rotate-route";
import { rotationCoordinator } from "./services/rotation-coordinator";
import { createFlushHandler } from "./services/flush-route";
import { createDeletedFileWebhookHandler } from "./services/deleted-file-webhook";
import { createLightNode } from "@waku/sdk";
import protobuf from "protobufjs";
import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import crypto from "crypto";
import {
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData,
  AppServer,
} from "./types/index";

const ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ORPHAN_GC_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6h

class CollaborationServer {
  private app: express.Application;
  private server: any;
  private io: AppServer | null = null;
  private waku: any;
  private orphanGcInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.app = express();
    this.setupMiddleware();
  }

  private setupMiddleware() {
    // Security
    this.app.use(
      helmet({
        contentSecurityPolicy: false, // Disable CSP for WebSocket connections
      })
    );

    // CORS
    this.app.use(
      cors({
        origin: config.corsOrigins,
        credentials: true,
      })
    );

    // Compression
    this.app.use(compression());

    // Body parsing
    this.app.use(express.json({ limit: "10mb" }));
    this.app.use(express.urlencoded({ extended: true }));

    // Request logging
    this.app.use((req, res, next) => {
      console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
      next();
    });
  }

  private setupRoutes() {
    if (!this.io) throw new Error("io must be created before routes are mounted");

    // Health check with MongoDB connectivity
    this.app.get("/health", async (req, res) => {
      const mongoOk = mongoose.connection.readyState === 1;
      const status = mongoOk ? "ok" : "degraded";
      res.status(mongoOk ? 200 : 503).json({
        status,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        mongo: mongoOk ? "connected" : "disconnected",
      });
    });

    this.app.post(
      "/documents/:documentId/collab-join-enabled",
      createCollabJoinEnabledHandler({ authService, sessionManager }, this.io)
    );
    this.app.post(
      "/documents/:documentId/workspace-edit-tier",
      createWorkspaceEditTierHandler({ authService, sessionManager }, this.io)
    );
    this.app.post(
      "/documents/:documentId/evict-edit-actors",
      createEvictEditActorsHandler({ authService, sessionManager, mongodbStore }, this.io)
    );
    this.app.post(
      "/workspaces/:portalAddress/evict-member",
      createEvictWorkspaceMemberHandler({ authService, sessionManager }, this.io)
    );
    this.app.post(
      "/documents/:documentId/rotate-session",
      createRotateSessionHandler({
        authService, sessionManager, mongodbStore, rotationCoordinator,
        terminateOldSession: async (documentId, sessionDid, appType) => {
          const room = getRoomName(documentId, sessionDid);
          const sockets = await this.io!.in(room).fetchSockets();
          // Laggard sockets stay AUTHED: their next write must reach createUpdate and get the
          // D-11 SESSION_TERMINATED 409 — that ack is their self-heal signal.
          // De-authing here would surface a 401 first and strand them frozen.
          // See docs/architecture/gp-semaphore.md.
          for (const s of sockets) { s.leave(room); }
          await sessionManager.deactivateSession(documentId, sessionDid);
          await sessionManager.terminateSession(documentId, sessionDid, appType);
        },
      }, this.io)
    );
    this.app.get(
      "/documents/:documentId/mirror",
      createMirrorReadHandler({ mongodbStore })
    );
    this.app.get(
      "/documents/:documentId/share-context",
      createShareContextHandler({ mongodbStore, sessionManager })
    );
    this.app.post(
      "/webhooks/file-deleted",
      createDeletedFileWebhookHandler({
        mongodbStore,
        onTombstoned: async (documentId) => {
          const sessions = await sessionManager.getNonTerminatedSessionsForDocument(documentId);
          for (const s of sessions) {
            const room = getRoomName(documentId, s.sessionDid);
            this.io!.to(room).emit("/session/terminated", { roomId: documentId });
            for (const sock of await this.io!.in(room).fetchSockets()) sock.leave(room);
            await sessionManager.terminateSession(documentId, s.sessionDid, s.appType ?? "ddoc");
          }
        },
      })
    );
    this.app.post("/flush", createFlushHandler({ authService, mongodbStore }));
    this.app.post("/list-my-documents", createListMyDocumentsHandler({ authService, mongodbStore }));
    this.app.delete(
      "/documents/:documentId",
      createDeleteDocumentHandler({ authService, sessionManager, mongodbStore })
    );

    // 404 handler
    this.app.use("*", (req, res) => {
      res.status(404).json({
        error: "Not found",
        message: `Route ${req.method} ${req.originalUrl} not found`,
      });
    });

    // Error handler
    this.app.use(
      (err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
        console.error("Express error:", err);
        res.status(500).json({
          error: "Internal server error",
          message: process.env.NODE_ENV === "development" ? err.message : "Something went wrong",
        });
      }
    );
  }

  async start() {
    try {
      if (!config.gate.did) {
        console.warn(
          "[startup] GATE_DID is not set — GP (private/group) live editing is DISABLED; only owner/workspace/public rails admit writes."
        );
      }

      // Initialize database connection
      await databaseService.connect();

      // Create HTTP server
      this.server = createServer(this.app);

      // Setup Socket.IO server
      const socketIOOptions = {
        cors: {
          origin: config.corsOrigins,
          credentials: true,
        },
        pingInterval: config.socketio.pingInterval,
        pingTimeout: config.socketio.pingTimeout,
        maxHttpBufferSize: config.socketio.maxHttpBufferSize,
      };
      this.io = new Server<
        ClientToServerEvents,
        ServerToClientEvents,
        InterServerEvents,
        SocketData
      >(this.server, socketIOOptions);

      // Redis adapter is only needed to scale beyond a single instance.
      if (config.redis.enabled) {
        this.io.adapter(createRedisAdapter());
      }

      // Socket.IO middlewares gets executed for every incoming connection.
      this.io.use(authMiddleware);

      registerEventHandlers(this.io);

      this.setupRoutes();

      // Orphan GC sweep
      this.orphanGcInterval = setInterval(
        () => mongodbStore.collectOrphans(ORPHAN_GRACE_MS).catch((e) => console.error("orphan-GC error:", e)),
        ORPHAN_GC_INTERVAL_MS
      );

      // Start the server
      this.server.listen(config.port, config.host, () => {
        console.log(`Collaboration server running on ${config.host}:${config.port}`);
        console.log(`Socket.IO endpoint: http://${config.host}:${config.port}/socket.io/`);
        console.log(`Server DID: ${authService.getServerDid()}`);
        console.log(`CORS origins: ${config.corsOrigins.join(", ")}`);
      });

      // Graceful shutdown
      process.on("SIGTERM", () => this.shutdown("SIGTERM"));
      process.on("SIGINT", () => this.shutdown("SIGINT"));
    } catch (error) {
      console.error("Failed to start server:", error);
      process.exit(1);
    }
  }

  private shutdown(signal: string) {
    console.log(`\n Received ${signal}. Shutting down gracefully...`);

    if (this.orphanGcInterval) {
      clearInterval(this.orphanGcInterval);
    }

    if (this.io) {
      this.io.close(() => {
        console.log("Socket.IO server closed");
      });
    }

    if (this.server) {
      this.server.close(async () => {
        console.log("HTTP server closed");

        // Cleanup session manager
        try {
          sessionManager.destroy();
          console.log("Session manager cleaned up");
        } catch (error) {
          console.error("Error cleaning up session manager:", error);
        }

        // Disconnect from database
        try {
          await databaseService.disconnect();
          console.log("Database connection closed");
        } catch (error) {
          console.error("Error closing database connection:", error);
        }

        process.exit(0);
      });
    }

    // Force exit after 10 seconds
    setTimeout(async () => {
      console.log("Force closing server");
      try {
        sessionManager.destroy();
        await databaseService.disconnect();
      } catch (error) {
        console.error("Error during force shutdown:", error);
      }
      process.exit(1);
    }, 10000);
  }

  async setupWaku() {
    try {
      const privateKey = await generateKeyPairFromSeed("Ed25519", crypto.randomBytes(32));
      this.waku = await createLightNode({
        defaultBootstrap: true,
        discovery: {
          dns: true,
          peerExchange: true,
          peerCache: true,
        },
        libp2p: {
          privateKey,
        },
      });
      console.log("Waku created:", this.waku);
      await this.waku.start();
      console.log("Waku started");

      // creating encoder
      const encoder = this.waku.createEncoder({
        contentTopic: `/ddocs/1/server-discovery-response/proto`,
      });
      console.log("Encoder created:", encoder);

      // creating decoder
      console.log("Creating decoder...");
      const decoder = this.waku.createDecoder({
        contentTopic: `/ddocs/1/server-discovery-request/proto`,
      });
      console.log("Decoder created:", decoder);

      // Create a message structure using Protobuf
      const DataPacket = new protobuf.Type("DataPacket")
        .add(new protobuf.Field("timestamp", 1, "uint64"))
        .add(new protobuf.Field("sender", 2, "string"))
        .add(new protobuf.Field("message", 3, "string"));
      // creating a new message object
      const wakuMessageSend = DataPacket.create({
        timestamp: Date.now(),
        sender: "Server",
        message: config.wsURL,
      });
      console.log("Waku message send:", wakuMessageSend);

      // subscribing to the decoder
      await this.waku.filter.subscribe(decoder, (wakuMessage: any) => {
        const decodedMessage: any = DataPacket.decode(wakuMessage.payload);
        console.log("Decoded message:", decodedMessage);
        if (decodedMessage && decodedMessage.sender === "dDocs-Client") {
          // sending the message to the encoder
          this.waku.lightPush
            .send(encoder, { payload: DataPacket.encode(wakuMessageSend).finish() })
            .then((result: any) => {
              console.log("Result:", result);
            })
            .catch(console.log);
        }
      });
    } catch (error) {
      console.error("Error starting Waku:", error);
    }
  }
}

// Start the collaboration server
const server = new CollaborationServer();
server
  .start()
  .then(() => {
    if (config.wsURL && config.wsURL !== "wss://0.0.0.0:5001") {
      server.setupWaku().catch(console.log);
    }
  })
  .catch((error) => {
    console.error("Failed to start collaboration server:", error);
    process.exit(1);
  });
