import mongoose from "mongoose";
import { config } from "../config";
import { logger } from "../services/logger";

class DatabaseService {
  private isConnected = false;

  async connect(): Promise<void> {
    if (this.isConnected) {
      logger.info("Database already connected");
      return;
    }

    try {
      const connectionString = config.database.uri;

      if (!connectionString) {
        throw new Error("MongoDB connection string not provided");
      }

      logger.info("Connecting to MongoDB...");

      await mongoose.connect(connectionString, {
        // Connection pool settings
        maxPoolSize: 10,
        minPoolSize: 2,
        maxIdleTimeMS: 60000, // Increased to prevent frequent disconnections

        // Timeout settings - more lenient
        serverSelectionTimeoutMS: 30000, // Increased timeout
        socketTimeoutMS: 0, // No socket timeout for long-running connections
        connectTimeoutMS: 30000, // Increased connection timeout

        // Heartbeat settings - less frequent to reduce chatter
        heartbeatFrequencyMS: 30000, // Reduced frequency

        // Simplified write/read concerns
        writeConcern: {
          w: 1, // Faster writes
          j: false, // No journaling requirement
        },
        readPreference: "primary",

        // Retry settings
        retryWrites: true,
        retryReads: true,

        // Disable buffering for real-time
        bufferCommands: false,
      });

      this.isConnected = true;
      logger.info("✅ Connected to MongoDB successfully");

      // Handle connection events
      mongoose.connection.on("error", (error) => {
        logger.error({ err: error }, "MongoDB connection error");
        this.isConnected = false;
      });

      mongoose.connection.on("disconnected", () => {
        logger.info("MongoDB disconnected");
        this.isConnected = false;
      });

      mongoose.connection.on("reconnected", () => {
        logger.info("MongoDB reconnected");
        this.isConnected = true;
      });

      mongoose.connection.on("close", () => {
        logger.info("MongoDB connection closed");
        this.isConnected = false;
      });
    } catch (error) {
      logger.error({ err: error }, "Failed to connect to MongoDB");
      this.isConnected = false;
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    try {
      await mongoose.disconnect();
      this.isConnected = false;
      logger.info("Disconnected from MongoDB");
    } catch (error) {
      logger.error({ err: error }, "Error disconnecting from MongoDB");
      throw error;
    }
  }
}

export const databaseService = new DatabaseService();
