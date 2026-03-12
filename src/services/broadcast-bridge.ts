import { WebSocket } from "ws";
import {
  AppServer,
  WebSocketEvent,
  ContentUpdatePayload,
  AwarenessUpdatePayload,
  MembershipChangePayload,
  SessionTerminatedPayload,
  ServerErrorPayload,
  ErrorCode,
} from "../types/index";
import type { LegacyWebSocketHandler } from "./legacy-ws-handler";

function getRoomName(documentId: string, sessionDid: string): string {
  return `session::${documentId}__${sessionDid}`;
}

/**
 * Coordinates cross-protocol broadcasting between Socket.IO and legacy WebSocket clients.
 *
 * - broadcastFromSocketIO: called after Socket.IO emits to its room; sends to legacy WS clients only
 * - broadcastFromLegacy: called from legacy handler; sends to both other legacy clients AND Socket.IO room
 * - getCombinedPeers: returns peer list from both protocols
 * - terminateRoom: force-disconnects clients of both protocols
 */
export class BroadcastBridge {
  constructor(
    private io: AppServer,
    private legacyHandler: LegacyWebSocketHandler
  ) {}

  /**
   * Called after Socket.IO has already emitted to its room.
   * Translates the Socket.IO event to legacy WS format and sends to legacy clients only.
   */
  broadcastFromSocketIO(
    documentId: string,
    sessionDid: string,
    event: string,
    payload: any,
    excludeSocketId?: string
  ): void {
    const legacyEvent = this.socketIOToLegacy(event, payload, documentId);
    if (!legacyEvent) return;

    // Send to legacy clients only (Socket.IO already handled its own)
    this.legacyHandler.broadcastToLegacyClients(
      documentId,
      sessionDid,
      legacyEvent
    );
  }

  /**
   * Called from legacy handler after processing a command.
   * Sends to other legacy clients AND emits to the Socket.IO room.
   */
  broadcastFromLegacy(
    documentId: string,
    sessionDid: string,
    legacyEvent: WebSocketEvent,
    excludeClientId?: string
  ): void {
    // Send to other legacy clients
    this.legacyHandler.broadcastToLegacyClients(
      documentId,
      sessionDid,
      legacyEvent,
      excludeClientId
    );

    // Translate and emit to Socket.IO room
    const roomName = getRoomName(documentId, sessionDid);
    this.emitToSocketIORoom(roomName, legacyEvent, documentId);
  }

  /**
   * Returns combined peer list from both protocols.
   */
  async getCombinedPeers(documentId: string, sessionDid: string): Promise<string[]> {
    const roomName = getRoomName(documentId, sessionDid);

    // Socket.IO peers
    const sockets = await this.io.in(roomName).fetchSockets();
    const socketIOPeers = sockets.map((s) => s.id);

    // Legacy WS peers
    const legacyPeers = this.legacyHandler.getLegacyPeers(documentId, sessionDid);

    return [...socketIOPeers, ...legacyPeers];
  }

  /**
   * Force-disconnects clients of both protocols in a room.
   */
  async terminateRoom(
    documentId: string,
    sessionDid: string,
    excludeClientId?: string
  ): Promise<void> {
    // Disconnect legacy clients
    this.legacyHandler.disconnectClientsInRoom(documentId, sessionDid, excludeClientId);

    // Disconnect Socket.IO clients
    const roomName = getRoomName(documentId, sessionDid);
    const sockets = await this.io.in(roomName).fetchSockets();
    for (const s of sockets) {
      if (excludeClientId && s.id === excludeClientId) continue;
      s.data.authenticated = false;
      s.leave(roomName);
    }
  }

  /**
   * Disconnects only legacy WS clients in a room (used when Socket.IO side handles its own cleanup).
   */
  disconnectLegacyClientsInRoom(
    documentId: string,
    sessionDid: string,
    excludeClientId?: string
  ): void {
    this.legacyHandler.disconnectClientsInRoom(documentId, sessionDid, excludeClientId);
  }

  /**
   * Emits a /server/error event to the Socket.IO room so clients know why their session ended.
   * Legacy WS clients don't use this event — it's Socket.IO-only.
   */
  emitServerError(
    documentId: string,
    sessionDid: string,
    message: string
  ): void {
    const roomName = getRoomName(documentId, sessionDid);
    this.io.to(roomName).emit("/server/error", {
      errorCode: ErrorCode.SESSION_TERMINATED,
      message,
      roomId: documentId,
    } as ServerErrorPayload);
  }

  /**
   * Translates a Socket.IO event to legacy WebSocketEvent format.
   */
  private socketIOToLegacy(
    event: string,
    payload: any,
    documentId: string
  ): WebSocketEvent | null {
    switch (event) {
      case "/document/content_update":
        return {
          type: "CONTENT_UPDATE",
          event_type: "CONTENT_UPDATE",
          event: {
            data: {
              id: payload.id,
              data: payload.data,
              createdAt: payload.createdAt,
            },
            roomId: documentId,
          },
        };

      case "/document/awareness_update":
        return {
          type: "AWARENESS_UPDATE",
          event_type: "AWARENESS_UPDATE",
          event: {
            data: payload.data,
            roomId: documentId,
          },
        };

      case "/room/membership_change":
        return {
          type: "ROOM_UPDATE",
          event_type: "ROOM_MEMBERSHIP_CHANGE",
          event: {
            data: {
              action: payload.action,
              user: payload.user,
            },
            roomId: documentId,
          },
        };

      case "/session/terminated":
        return {
          type: "SESSION_TERMINATED",
          event_type: "SESSION_TERMINATED",
          event: {
            data: null,
            roomId: documentId,
          },
        };

      default:
        return null;
    }
  }

  /**
   * Translates a legacy WebSocketEvent and emits to the Socket.IO room.
   */
  private emitToSocketIORoom(
    roomName: string,
    legacyEvent: WebSocketEvent,
    documentId: string
  ): void {
    switch (legacyEvent.event_type) {
      case "CONTENT_UPDATE":
        this.io.to(roomName).emit("/document/content_update", {
          id: legacyEvent.event.data?.id,
          data: legacyEvent.event.data?.data,
          createdAt: legacyEvent.event.data?.createdAt,
          roomId: documentId,
        } as ContentUpdatePayload);
        break;

      case "AWARENESS_UPDATE":
        this.io.to(roomName).emit("/document/awareness_update", {
          data: legacyEvent.event.data,
          roomId: documentId,
        } as AwarenessUpdatePayload);
        break;

      case "ROOM_MEMBERSHIP_CHANGE":
        this.io.to(roomName).emit("/room/membership_change", {
          action: legacyEvent.event.data?.action,
          user: legacyEvent.event.data?.user,
          roomId: documentId,
        } as MembershipChangePayload);
        break;

      case "SESSION_TERMINATED":
        this.io.to(roomName).emit("/session/terminated", {
          roomId: documentId,
        } as SessionTerminatedPayload);
        break;
    }
  }
}
