import { v4 as uuidv4 } from "uuid";
import { MessageLogModel, IMessageLog } from "../database/models";

class MessageLogger {
  // Configuration
  private readonly MAX_BUFFER_SIZE = 100;
  private readonly FLUSH_INTERVAL_MS = 5000;

  // State
  private buffer: Partial<IMessageLog>[] = [];
  private flushInterval: NodeJS.Timeout | null = null;
  private readonly enabled: boolean;
  private readonly dynoId: string;

  constructor() {
    this.enabled = process.env.ENABLE_MESSAGE_LOGGING === "true";
    this.dynoId = process.env.DYNO || `local-${process.pid}`;

    if (this.enabled) {
      this.flushInterval = setInterval(() => {
        this.flush();
      }, this.FLUSH_INTERVAL_MS);

      console.log("[MessageLogger] Enabled, flushing every 5s or 100 messages");
    }
  }

  // Public methods
  logInbound(
    ws: {
      clientId?: string;
      documentId?: string;
      sessionDid?: string;
      role?: string;
      authenticated?: boolean;
    },
    message: {
      cmd?: string;
      args?: any;
      seqId?: string;
    },
    protocol: "websocket" | "socketio"
  ): void {
    if (!this.enabled) return;

    this.buffer.push({
      _id: uuidv4(),
      timestamp: Date.now(),
      connectionId: ws.clientId || "unknown",
      direction: "inbound",
      protocol,
      message: {
        cmd: message.cmd,
        args: this.sanitizeArgs(message.args),
        seqId: message.seqId,
      },
      context: this.extractContext(ws),
      dynoId: this.dynoId,
    });

    this.checkBufferSize();
  }

  logOutbound(
    ws: {
      clientId?: string;
      documentId?: string;
      sessionDid?: string;
      role?: string;
      authenticated?: boolean;
    },
    response: {
      status?: boolean;
      statusCode?: number;
      seqId?: string | null;
      is_handshake_response?: boolean;
      data?: Record<string, any>;
    },
    protocol: "websocket" | "socketio"
  ): void {
    if (!this.enabled) return;

    this.buffer.push({
      _id: uuidv4(),
      timestamp: Date.now(),
      connectionId: ws.clientId || "unknown",
      direction: "outbound",
      protocol,
      message: {
        seqId: response.seqId || undefined, // This seqId helps in mapping request and responses
      },
      context: this.extractContext(ws),
      response: {
        status: response.status ?? false,
        statusCode: response.statusCode ?? 0,
        latencyMs: 0, // not tracking latency for now (simplified)
        isHandshakeResponse: response.is_handshake_response,
        data: response.data,
      },
      dynoId: this.dynoId,
    });

    this.checkBufferSize();
  }

  logBroadcast(
    sessionKey: string,
    event: {
      type?: string;
      event_type?: string;
    },
    protocol: "websocket" | "socketio"
  ): void {
    if (!this.enabled) return;

    const [documentId, sessionDid] = sessionKey.split("__");

    this.buffer.push({
      _id: uuidv4(),
      timestamp: Date.now(),
      connectionId: "broadcast", // Special marker
      direction: "broadcast",
      protocol,
      message: {
        cmd: event.type || event.event_type,
      },
      context: {
        documentId,
        sessionDid,
        authenticated: true,
      },
      dynoId: this.dynoId,
    });

    this.checkBufferSize();
  }

  // Internal methods
  private extractContext(ws: {
    documentId?: string;
    sessionDid?: string;
    role?: string;
    authenticated?: boolean;
  }): IMessageLog["context"] {
    return {
      documentId: ws.documentId,
      sessionDid: ws.sessionDid,
      role: (ws.role === "owner" || ws.role === "editor") ? ws.role : undefined,
      authenticated: ws.authenticated || false,
    };
  }

  private sanitizeArgs(args: any): any {
    if (!args) return args;

    const sanitized = { ...args };

    // Redact sensitive tokens
    if (sanitized.ownerToken) sanitized.ownerToken = "[REDACTED]";
    if (sanitized.collaborationToken) sanitized.collaborationToken = "[REDACTED]";

    return sanitized;
  }

  private checkBufferSize(): void {
    if (this.buffer.length >= this.MAX_BUFFER_SIZE) {
      this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    // Copy and clear buffer immediately (non-blocking)
    const toInsert = this.buffer;
    this.buffer = [];

    try {
      await MessageLogModel.insertMany(toInsert, { ordered: false });
      console.log(`[MessageLogger] Flushed ${toInsert.length} logs`);
    } catch (error) {
      console.error("[MessageLogger] Flush failed:", error);
      // TODO: think, on failure, should I re-add? or accept data loss?
    }
  }

  destroy(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }

    this.flush().catch(console.error);

    console.log("[MessageLogger] Destroyed");
  }
}

export const messageLogger = new MessageLogger();
