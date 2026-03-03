import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleDisconnecting } from "./socket-handlers";
import type { AppSocket } from "../types/index";
import type { SocketHandlerDeps } from "./socket-handlers.deps";

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
  const deps: SocketHandlerDeps = {
    authService: fakeAuthService as any,
    sessionManager: fakeSessionManager as any,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns early when socket is not authenticated", async () => {
    const fakeSocket = createFakeSocket(undefined, { authenticated: false });

    await handleDisconnecting(deps, fakeSocket);

    expect(fakeSocket.to).not.toHaveBeenCalled();
    expect(fakeSessionManager.removeClientFromSession).not.toHaveBeenCalled();
  });

  it("returns early when documentId is missing", async () => {
    const fakeSocket = createFakeSocket(undefined, { documentId: "" });

    await handleDisconnecting(deps, fakeSocket);

    expect(fakeSocket.to).not.toHaveBeenCalled();
    expect(fakeSessionManager.removeClientFromSession).not.toHaveBeenCalled();
  });

  it("returns early when sessionDid is missing", async () => {
    const fakeSocket = createFakeSocket(undefined, { sessionDid: "" });

    await handleDisconnecting(deps, fakeSocket);

    expect(fakeSocket.to).not.toHaveBeenCalled();
    expect(fakeSessionManager.removeClientFromSession).not.toHaveBeenCalled();
  });

  it("broadcasts membership_change and calls removeClientFromSession when socket has full data", async () => {
    const fakeBroadcastOperator = { emit: vi.fn() };
    const fakeSocket = createFakeSocket(fakeBroadcastOperator);

    fakeSessionManager.removeClientFromSession.mockResolvedValue(undefined);

    await handleDisconnecting(deps, fakeSocket);

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
  });
});
