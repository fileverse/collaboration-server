import mongoose from "mongoose";
import { config } from "../config";

class DatabaseService {
  private isConnected = false;

  async connect(): Promise<void> {
    if (this.isConnected) {
      console.log("Database already connected");
      return;
    }

    try {
      const connectionString = config.database.uri;

      if (!connectionString) {
        throw new Error("MongoDB connection string not provided");
      }

      console.log("Connecting to MongoDB...");

      // Adjust pool size based on clustering
      const totalWorkers = parseInt(process.env.TOTAL_WORKERS || "1");
      const maxPoolPerWorker = Math.max(2, Math.floor(10 / totalWorkers)); // Distribute pool across workers

      await mongoose.connect(connectionString, {
        // Memory-optimized connection pool settings
        maxPoolSize: maxPoolPerWorker,
        minPoolSize: 1,
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
      console.log("✅ Connected to MongoDB successfully");

      // Handle connection events
      mongoose.connection.on("error", (error) => {
        console.error("MongoDB connection error:", error);
        this.isConnected = false;
      });

      mongoose.connection.on("disconnected", () => {
        console.log("MongoDB disconnected");
        this.isConnected = false;
      });

      mongoose.connection.on("reconnected", () => {
        console.log("MongoDB reconnected");
        this.isConnected = true;
      });

      mongoose.connection.on("close", () => {
        console.log("MongoDB connection closed");
        this.isConnected = false;
      });
    } catch (error) {
      console.error("Failed to connect to MongoDB:", error);
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
      console.log("Disconnected from MongoDB");
    } catch (error) {
      console.error("Error disconnecting from MongoDB:", error);
      throw error;
    }
  }
}

export const databaseService = new DatabaseService();
