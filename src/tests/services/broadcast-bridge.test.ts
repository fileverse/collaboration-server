import { describe, it, expect, vi, beforeEach } from "vitest";
import { BroadcastBridge } from "../../services/broadcast-bridge";
import type { AppServer, WebSocketEvent } from "../../types";
import { ErrorCode } from "../../types";
import type { LegacyWebSocketHandler } from "../../services/legacy-ws-handler";

function createFakeIO(options?: {
  broadcastOperator?: { emit: ReturnType<typeof vi.fn> };
  fetchSockets?: ReturnType<typeof vi.fn>;
}): AppServer {
  const op = options?.broadcastOperator ?? { emit: vi.fn() };
  const fetchSockets = options?.fetchSockets ?? vi.fn().mockResolvedValue([]);
  return {
    to: vi.fn(() => op),
    in: vi.fn(() => ({ fetchSockets })),
  } as unknown as AppServer;
}

function createFakeLegacyHandler(): LegacyWebSocketHandler {
  return {
    broadcastToLegacyClients: vi.fn(),
    getLegacyPeers: vi.fn().mockReturnValue([]),
    disconnectClientsInRoom: vi.fn(),
  } as unknown as LegacyWebSocketHandler;
}

describe("BroadcastBridge", () => {
  let bridge: BroadcastBridge;
  let fakeLegacyHandler: LegacyWebSocketHandler;
  let fakeBroadcastOperator: { emit: ReturnType<typeof vi.fn> };
  let fakeIO: AppServer;

  beforeEach(() => {
    fakeBroadcastOperator = { emit: vi.fn() };
    fakeIO = createFakeIO({ broadcastOperator: fakeBroadcastOperator });
    fakeLegacyHandler = createFakeLegacyHandler();
    bridge = new BroadcastBridge(fakeIO, fakeLegacyHandler);
    vi.clearAllMocks();
  });

  // broadcastFromSocketIO

  it("translates /document/content_update and broadcasts to legacy clients", () => {
    const payload = { id: "update-1", data: "encrypted-data", createdAt: 1000, roomId: "doc-1" };

    bridge.broadcastFromSocketIO("doc-1", "session-1", "/document/content_update", payload);

    expect(fakeLegacyHandler.broadcastToLegacyClients).toHaveBeenCalledWith(
      "doc-1",
      "session-1",
      {
        type: "CONTENT_UPDATE",
        event_type: "CONTENT_UPDATE",
        event: {
          data: { id: payload.id, data: payload.data, createdAt: payload.createdAt },
          roomId: "doc-1",
        },
      }
    );
  });

  it("translates /document/awareness_update and broadcasts to legacy clients", () => {
    const payload = { data: { position: "abc" }, roomId: "doc-1" };

    bridge.broadcastFromSocketIO("doc-1", "session-1", "/document/awareness_update", payload);

    expect(fakeLegacyHandler.broadcastToLegacyClients).toHaveBeenCalledWith(
      "doc-1",
      "session-1",
      {
        type: "AWARENESS_UPDATE",
        event_type: "AWARENESS_UPDATE",
        event: {
          data: payload.data,
          roomId: "doc-1",
        },
      }
    );
  });

  it("translates /room/membership_change and broadcasts to legacy clients", () => {
    const payload = { action: "user_joined", user: { role: "editor" }, roomId: "doc-1" };

    bridge.broadcastFromSocketIO("doc-1", "session-1", "/room/membership_change", payload);

    expect(fakeLegacyHandler.broadcastToLegacyClients).toHaveBeenCalledWith(
      "doc-1",
      "session-1",
      {
        type: "ROOM_UPDATE",
        event_type: "ROOM_MEMBERSHIP_CHANGE",
        event: {
          data: { action: payload.action, user: payload.user },
          roomId: "doc-1",
        },
      }
    );
  });

  it("translates /session/terminated and broadcasts to legacy clients", () => {
    const payload = { roomId: "doc-1" };

    bridge.broadcastFromSocketIO("doc-1", "session-1", "/session/terminated", payload);

    expect(fakeLegacyHandler.broadcastToLegacyClients).toHaveBeenCalledWith(
      "doc-1",
      "session-1",
      {
        type: "SESSION_TERMINATED",
        event_type: "SESSION_TERMINATED",
        event: {
          data: null,
          roomId: "doc-1",
        },
      }
    );
  });

  it("does not broadcast to legacy clients when the event has no legacy translation", () => {
    bridge.broadcastFromSocketIO("doc-1", "session-1", "/unknown/event", {});

    expect(fakeLegacyHandler.broadcastToLegacyClients).not.toHaveBeenCalled();
  });

  // broadcastFromLegacy

  it("forwards CONTENT_UPDATE to legacy clients and emits to the Socket.IO room", () => {
    const legacyEvent: WebSocketEvent = {
      type: "CONTENT_UPDATE",
      event_type: "CONTENT_UPDATE",
      event: {
        data: { id: "update-1", data: "encrypted-data", createdAt: 1000 },
        roomId: "doc-1",
      },
    };

    bridge.broadcastFromLegacy("doc-1", "session-1", legacyEvent, "legacy-client-1");

    const roomName = "session::doc-1__session-1";

    expect(fakeLegacyHandler.broadcastToLegacyClients).toHaveBeenCalledWith(
      "doc-1",
      "session-1",
      legacyEvent,
      "legacy-client-1"
    );
    expect(fakeIO.to).toHaveBeenCalledWith(roomName);
    expect(fakeBroadcastOperator.emit).toHaveBeenCalledWith("/document/content_update", {
      id: legacyEvent.event.data.id,
      data: legacyEvent.event.data.data,
      createdAt: legacyEvent.event.data.createdAt,
      roomId: "doc-1",
    });
  });

  it("forwards AWARENESS_UPDATE to legacy clients and emits to the Socket.IO room", () => {
    const legacyEvent: WebSocketEvent = {
      type: "AWARENESS_UPDATE",
      event_type: "AWARENESS_UPDATE",
      event: {
        data: { position: "abc" },
        roomId: "doc-1",
      },
    };

    bridge.broadcastFromLegacy("doc-1", "session-1", legacyEvent);

    const roomName = "session::doc-1__session-1";

    expect(fakeLegacyHandler.broadcastToLegacyClients).toHaveBeenCalledWith(
      "doc-1",
      "session-1",
      legacyEvent,
      undefined
    );
    expect(fakeIO.to).toHaveBeenCalledWith(roomName);
    expect(fakeBroadcastOperator.emit).toHaveBeenCalledWith("/document/awareness_update", {
      data: legacyEvent.event.data,
      roomId: "doc-1",
    });
  });

  it("forwards ROOM_MEMBERSHIP_CHANGE to legacy clients and emits to the Socket.IO room", () => {
    const legacyEvent: WebSocketEvent = {
      type: "ROOM_UPDATE",
      event_type: "ROOM_MEMBERSHIP_CHANGE",
      event: {
        data: { action: "user_left", user: { role: "editor" } },
        roomId: "doc-1",
      },
    };

    bridge.broadcastFromLegacy("doc-1", "session-1", legacyEvent);

    const roomName = "session::doc-1__session-1";

    expect(fakeLegacyHandler.broadcastToLegacyClients).toHaveBeenCalledWith(
      "doc-1",
      "session-1",
      legacyEvent,
      undefined
    );
    expect(fakeIO.to).toHaveBeenCalledWith(roomName);
    expect(fakeBroadcastOperator.emit).toHaveBeenCalledWith("/room/membership_change", {
      action: legacyEvent.event.data.action,
      user: legacyEvent.event.data.user,
      roomId: "doc-1",
    });
  });

  it("forwards SESSION_TERMINATED to legacy clients and emits to the Socket.IO room", () => {
    const legacyEvent: WebSocketEvent = {
      type: "SESSION_TERMINATED",
      event_type: "SESSION_TERMINATED",
      event: {
        data: null,
        roomId: "doc-1",
      },
    };

    bridge.broadcastFromLegacy("doc-1", "session-1", legacyEvent);

    const roomName = "session::doc-1__session-1";

    expect(fakeLegacyHandler.broadcastToLegacyClients).toHaveBeenCalledWith(
      "doc-1",
      "session-1",
      legacyEvent,
      undefined
    );
    expect(fakeIO.to).toHaveBeenCalledWith(roomName);
    expect(fakeBroadcastOperator.emit).toHaveBeenCalledWith("/session/terminated", {
      roomId: "doc-1",
    });
  });

  // getCombinedPeers

  it("returns combined peer list from both Socket.IO and legacy clients", async () => {
    const fakeSockets = [{ id: "socket-1" }, { id: "socket-2" }];
    const fetchSockets = vi.fn().mockResolvedValue(fakeSockets);
    const localFakeIO = createFakeIO({ fetchSockets });
    const localFakeLegacyHandler = createFakeLegacyHandler();
    vi.mocked(localFakeLegacyHandler.getLegacyPeers).mockReturnValue(["legacy-1"]);
    const localBridge = new BroadcastBridge(localFakeIO, localFakeLegacyHandler);

    const peers = await localBridge.getCombinedPeers("doc-1", "session-1");

    const roomName = "session::doc-1__session-1";
    expect(localFakeIO.in).toHaveBeenCalledWith(roomName);
    expect(fetchSockets).toHaveBeenCalled();
    expect(localFakeLegacyHandler.getLegacyPeers).toHaveBeenCalledWith("doc-1", "session-1");
    expect(peers).toEqual(["socket-1", "socket-2", "legacy-1"]);
  });

  // terminateRoom

  it("disconnects legacy clients and all Socket.IO clients in the room", async () => {
    const fakeSockets = [
      { id: "socket-1", data: { authenticated: true }, leave: vi.fn() },
      { id: "socket-2", data: { authenticated: true }, leave: vi.fn() },
    ];
    const fetchSockets = vi.fn().mockResolvedValue(fakeSockets);
    const localFakeIO = createFakeIO({ fetchSockets });
    const localFakeLegacyHandler = createFakeLegacyHandler();
    const localBridge = new BroadcastBridge(localFakeIO, localFakeLegacyHandler);

    await localBridge.terminateRoom("doc-1", "session-1");

    const roomName = "session::doc-1__session-1";

    expect(localFakeLegacyHandler.disconnectClientsInRoom).toHaveBeenCalledWith(
      "doc-1",
      "session-1",
      undefined
    );
    expect(localFakeIO.in).toHaveBeenCalledWith(roomName);
    expect(fetchSockets).toHaveBeenCalled();

    // First socket
    expect(fakeSockets[0].data.authenticated).toBe(false);
    expect(fakeSockets[0].leave).toHaveBeenCalledWith(roomName);
    // Second socket
    expect(fakeSockets[1].data.authenticated).toBe(false);
    expect(fakeSockets[1].leave).toHaveBeenCalledWith(roomName);
    // Aggregate
    expect(fakeSockets[0].leave).toHaveBeenCalledTimes(1);
    expect(fakeSockets[1].leave).toHaveBeenCalledTimes(1);
  });

  it("skips the excluded client when terminating the room", async () => {
    const fakeSockets = [
      { id: "socket-1", data: { authenticated: true }, leave: vi.fn() },
      { id: "socket-2", data: { authenticated: true }, leave: vi.fn() },
    ];
    const fetchSockets = vi.fn().mockResolvedValue(fakeSockets);
    const localFakeIO = createFakeIO({ fetchSockets });
    const localFakeLegacyHandler = createFakeLegacyHandler();
    const localBridge = new BroadcastBridge(localFakeIO, localFakeLegacyHandler);

    await localBridge.terminateRoom("doc-1", "session-1", "socket-1");

    const roomName = "session::doc-1__session-1";

    expect(localFakeLegacyHandler.disconnectClientsInRoom).toHaveBeenCalledWith(
      "doc-1",
      "session-1",
      "socket-1"
    );
    expect(localFakeIO.in).toHaveBeenCalledWith(roomName);
    expect(fetchSockets).toHaveBeenCalled();
    expect(fakeSockets[0].data.authenticated).toBe(true);
    expect(fakeSockets[0].leave).not.toHaveBeenCalled();
    expect(fakeSockets[1].data.authenticated).toBe(false);
    expect(fakeSockets[1].leave).toHaveBeenCalledWith(roomName);
  });

  // disconnectLegacyClientsInRoom

  it("delegates to the legacy handler to disconnect clients in the room", () => {
    bridge.disconnectLegacyClientsInRoom("doc-1", "session-1", "client-1");

    expect(fakeLegacyHandler.disconnectClientsInRoom).toHaveBeenCalledWith(
      "doc-1",
      "session-1",
      "client-1"
    );
  });

  // emitServerError

  it("emits a server error to the Socket.IO room", () => {
    bridge.emitServerError("doc-1", "session-1", "Session terminated by owner");

    const roomName = "session::doc-1__session-1";

    expect(fakeIO.to).toHaveBeenCalledWith(roomName);
    expect(fakeBroadcastOperator.emit).toHaveBeenCalledWith("/server/error", {
      errorCode: ErrorCode.SESSION_TERMINATED,
      message: "Session terminated by owner",
      roomId: "doc-1",
    });
  });
});
