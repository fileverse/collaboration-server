import express from "express";
import { WebSocketServer } from "ws";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import { createServer } from "http";
import config from "./config/index";
import { authService } from "./services/auth";
import { wsManager } from "./services/websocket-manager";
import { databaseService } from "./database";
import { createLightNode } from "@waku/sdk";

class CollaborationServer {
  private app: express.Application;
  private server: any;
  private wss: WebSocketServer | null = null;
  private waku: any;

  constructor() {
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
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
    // Health check
    this.app.get("/health", async (req, res) => {
      const stats = await wsManager.getStats();
      res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        stats,
      });
    });

    // Server info
    this.app.get("/info", (req, res) => {
      res.json({
        name: "Fileverse Collaboration Server",
        version: "0.1.0",
        serverDid: authService.getServerDid(),
        features: ["websocket_collaboration", "ucan_auth", "real_time_sync", "awareness_protocol"],
      });
    });

    // WebSocket stats (for debugging)
    this.app.get("/stats", async (req, res) => {
      const stats = await wsManager.getStats();
      res.json(stats);
    });

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
      // Initialize database connection
      await databaseService.connect();

      // Create HTTP server
      this.server = createServer(this.app);

      // Setup WebSocket server
      this.wss = new WebSocketServer({
        server: this.server,
        path: "/",
        perMessageDeflate: {
          // Enable per-message compression
          threshold: 1024,
          concurrencyLimit: 10,
        },
      });

      // Handle WebSocket connections
      this.wss.on("connection", wsManager.handleConnection);

      // Start the server
      this.server.listen(config.port, config.host, () => {
        console.log(`🚀 Collaboration server running on ${config.host}:${config.port}`);
        console.log(`📡 WebSocket endpoint: ws://${config.host}:${config.port}/`);
        console.log(`🔑 Server DID: ${authService.getServerDid()}`);
        console.log(`🌍 CORS origins: ${config.corsOrigins.join(", ")}`);
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
    console.log(`\n📴 Received ${signal}. Shutting down gracefully...`);

    if (this.wss) {
      this.wss.close(() => {
        console.log("WebSocket server closed");
      });
    }

    if (this.server) {
      this.server.close(async () => {
        console.log("HTTP server closed");

        // Cleanup session manager
        try {
          await import("./services/session-manager");
          const { sessionManager } = await import("./services/session-manager");
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
        const { sessionManager } = await import("./services/session-manager");
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
      this.waku = await createLightNode({ defaultBootstrap: true });
      await this.waku.start();
      console.log("Waku started");
    } catch (error) {
      console.error("Error starting Waku:", error);
    }
  }
}

// Start the server
const server = new CollaborationServer();
server.start().catch((error) => {
  console.error("Failed to start collaboration server:", error);
  process.exit(1);
});
