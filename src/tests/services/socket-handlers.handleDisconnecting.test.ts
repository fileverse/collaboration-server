import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleDisconnecting } from "../../services/socket-handlers";
import type { AppServer, AppSocket } from "../../types";
import type { SocketHandlerDeps } from "../../services/socket-handlers.deps";
import { config } from "../../config";
import { markDraining, resetDrainingForTests } from "../../services/lifecycle";

/**
 * Fake server for handler tests. fetchSockets defaults to resolving with an empty
 * room, matching the case where no one else is left to ratchet the wire format for.
 */
function createFakeIO(): AppServer {
  return {
    to: vi.fn(() => ({ emit: vi.fn() })),
    in: vi.fn(() => ({ fetchSockets: vi.fn().mockResolvedValue([]) })),
  } as unknown as AppServer;
}

/**
 * Fake socket for handler tests.
 * If you pass a broadcastOperator, socket.to(room) will return it so you can assert
 * on broadcastOperator.emit(event, payload) in the test.
 * dataOverrides can be used to set authenticated, documentId, sessionDid, or role for early-return tests.
 */
function createFakeSocket(
  broadcastOperator?: { emit: ReturnType<typeof vi.fn> },
  dataOverrides?: Partial<{
    authenticated: boolean;
    documentId: string;
    sessionDid: string;
    role: "owner" | "editor";
  }>
): AppSocket {
  const toReturn = broadcastOperator ?? { emit: vi.fn() };
  const defaultData = {
    authenticated: true,
    documentId: "test-document-id",
    sessionDid: "test-session-did",
    role: "owner" as const,
  };
  const data = { ...defaultData, ...dataOverrides };
  const socket = {
    id: "socket-1",
    data,
    to: vi.fn(() => toReturn),
  } as unknown as AppSocket;
  return socket;
}

describe("handleDisconnecting", () => {
  const fakeAuthService = {
    verifyOwnerToken: vi.fn<[], Promise<string | null>>(),
  };
  const fakeSessionManager = {
    removeClientFromSession: vi.fn(),
  };
  const fakeMongoDBStore = {
    getWireFormat: vi.fn().mockResolvedValue("ecies"),
    lockWireFormat: vi.fn().mockResolvedValue(true),
  } as any;
  const deps: SocketHandlerDeps = {
    authService: fakeAuthService as any,
    sessionManager: fakeSessionManager as any,
    mongodbStore: fakeMongoDBStore,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns early when socket is not authenticated", async () => {
    const fakeSocket = createFakeSocket(undefined, { authenticated: false });

    await handleDisconnecting(deps, createFakeIO(), fakeSocket);

    expect(fakeSocket.to).not.toHaveBeenCalled();
    expect(fakeSessionManager.removeClientFromSession).not.toHaveBeenCalled();
  });

  it("returns early when documentId is missing", async () => {
    const fakeSocket = createFakeSocket(undefined, { documentId: "" });

    await handleDisconnecting(deps, createFakeIO(), fakeSocket);

    expect(fakeSocket.to).not.toHaveBeenCalled();
    expect(fakeSessionManager.removeClientFromSession).not.toHaveBeenCalled();
  });

  it("returns early when sessionDid is missing", async () => {
    const fakeSocket = createFakeSocket(undefined, { sessionDid: "" });

    await handleDisconnecting(deps, createFakeIO(), fakeSocket);

    expect(fakeSocket.to).not.toHaveBeenCalled();
    expect(fakeSessionManager.removeClientFromSession).not.toHaveBeenCalled();
  });

  it("broadcasts membership_change and calls removeClientFromSession when socket has full data", async () => {
    const fakeBroadcastOperator = { emit: vi.fn() };
    const fakeSocket = createFakeSocket(fakeBroadcastOperator);

    fakeSessionManager.removeClientFromSession.mockResolvedValue(undefined);

    await handleDisconnecting(deps, createFakeIO(), fakeSocket);

    const roomName = `session::${fakeSocket.data.documentId}__${fakeSocket.data.sessionDid}`;

    expect(fakeSocket.to).toHaveBeenCalledOnce();
    expect(fakeSocket.to).toHaveBeenCalledWith(roomName);
    expect(fakeBroadcastOperator.emit).toHaveBeenCalledWith("/room/membership_change", {
      action: "user_left",
      user: { role: fakeSocket.data.role },
      roomId: fakeSocket.data.documentId,
    });

    expect(fakeSessionManager.removeClientFromSession).toHaveBeenCalledOnce();
    expect(fakeSessionManager.removeClientFromSession).toHaveBeenCalledWith(
      fakeSocket.data.documentId,
      fakeSocket.data.sessionDid,
      fakeSocket.id
    );

    // F6 sibling assertion (fix wave 2): target is "ecies" here (unset), so the ratchet
    // bails before ever reading the lock.
    expect(fakeMongoDBStore.lockWireFormat).not.toHaveBeenCalled();
  });

  it("does not throw when an error occurs during disconnection cleanup", async () => {
    const fakeSocket = createFakeSocket(undefined, {
      authenticated: true,
      documentId: "doc-1",
      sessionDid: "session-1",
      role: "owner",
    });
    fakeSessionManager.removeClientFromSession.mockRejectedValue(new Error("db error"));

    await expect(handleDisconnecting(deps, createFakeIO(), fakeSocket)).resolves.not.toThrow();
  });

  describe("wire-format ratchet on leave", () => {
    let originalWireFormatTarget: typeof config.wireFormat.target;
    beforeEach(() => {
      originalWireFormatTarget = config.wireFormat.target;
    });
    afterEach(() => {
      config.wireFormat.target = originalWireFormatTarget;
      resetDrainingForTests();
    });

    it("ratchets the room to xchacha when the leaving socket was the last one without it", async () => {
      config.wireFormat.target = "xchacha";
      const fakeSocket = createFakeSocket();
      (fakeSocket.data as any).wireFormats = ["ecies"];

      const leavingSocketEntry = { id: fakeSocket.id, data: { wireFormats: ["ecies"] } };
      const capableRemote = {
        id: "remote-capable",
        data: { wireFormats: ["ecies", "xchacha"] },
        disconnect: vi.fn(),
      };
      const emit = vi.fn();
      const fetchSockets = vi.fn().mockResolvedValue([leavingSocketEntry, capableRemote]);
      const fakeIO = {
        to: vi.fn(() => ({ emit })),
        in: vi.fn(() => ({ fetchSockets })),
      } as unknown as AppServer;

      fakeSessionManager.removeClientFromSession.mockResolvedValue(undefined);

      await handleDisconnecting(deps, fakeIO, fakeSocket);

      expect(fakeMongoDBStore.lockWireFormat).toHaveBeenCalledWith(fakeSocket.data.documentId);
      expect(capableRemote.disconnect).not.toHaveBeenCalled();
      expect(emit).toHaveBeenCalledWith("/document/wire_format", {
        roomId: fakeSocket.data.documentId,
        wireFormat: "xchacha",
      });
    });

    // R4: a fetchSockets rejection inside the sweep, after the lock is already committed,
    // must not suppress the ratchet's emit. (This file does not mock/observe `logger`, so
    // the error-log side of R4 is not asserted here beyond the suite staying green.)
    it("still locks and emits when the sweep's fetchSockets rejects after the lock lands", async () => {
      config.wireFormat.target = "xchacha";
      const fakeSocket = createFakeSocket();
      (fakeSocket.data as any).wireFormats = ["ecies"];

      const leavingSocketEntry = { id: fakeSocket.id, data: { wireFormats: ["ecies"] } };
      const capableRemote = {
        id: "remote-capable",
        data: { wireFormats: ["ecies", "xchacha"] },
        disconnect: vi.fn(),
      };
      const emit = vi.fn();
      const fetchSockets = vi
        .fn()
        .mockResolvedValueOnce([leavingSocketEntry, capableRemote])
        .mockRejectedValueOnce(new Error("fetchSockets down"));
      const fakeIO = {
        to: vi.fn(() => ({ emit })),
        in: vi.fn(() => ({ fetchSockets })),
      } as unknown as AppServer;

      fakeSessionManager.removeClientFromSession.mockResolvedValue(undefined);

      await handleDisconnecting(deps, fakeIO, fakeSocket);

      expect(fakeMongoDBStore.lockWireFormat).toHaveBeenCalledWith(fakeSocket.data.documentId);
      expect(emit).toHaveBeenCalledWith("/document/wire_format", {
        roomId: fakeSocket.data.documentId,
        wireFormat: "xchacha",
      });
    });

    it("skips the ratchet entirely while the server is draining", async () => {
      config.wireFormat.target = "xchacha";
      markDraining();
      const fakeSocket = createFakeSocket();
      (fakeSocket.data as any).wireFormats = ["ecies"];

      const emit = vi.fn();
      const fetchSockets = vi.fn();
      const fakeIO = {
        to: vi.fn(() => ({ emit })),
        in: vi.fn(() => ({ fetchSockets })),
      } as unknown as AppServer;

      fakeSessionManager.removeClientFromSession.mockResolvedValue(undefined);

      await handleDisconnecting(deps, fakeIO, fakeSocket);

      // Session bookkeeping still runs; only the ratchet is skipped.
      expect(fakeSessionManager.removeClientFromSession).toHaveBeenCalledWith(
        fakeSocket.data.documentId,
        fakeSocket.data.sessionDid,
        fakeSocket.id
      );
      expect(fakeMongoDBStore.getWireFormat).not.toHaveBeenCalled();
      expect(fetchSockets).not.toHaveBeenCalled();
      expect(fakeMongoDBStore.lockWireFormat).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalledWith("/document/wire_format", expect.anything());
    });
  });
});
