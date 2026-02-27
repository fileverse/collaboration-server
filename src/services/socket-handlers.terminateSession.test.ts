import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleTerminateSession } from "./socket-handlers";
import type { SocketHandlerDeps } from "./socket-handlers.deps";
import type { AppServer, AppSocket } from "../types/index";
import type { Hex } from "viem";

function createFakeIo(socketsInRoom: any[] = []): AppServer {
  const fetchSocketsMock = vi.fn().mockResolvedValue(socketsInRoom);

  return {
    in: vi.fn(() => ({
      fetchSockets: fetchSocketsMock,
    })),
  } as unknown as AppServer;
}

function createFakeSocket() {
  const toEmits: { room: string; event: string; payload: unknown }[] = [];

  const socket = {
    id: "socket-1",
    data: {
      authenticated: true,
      documentId: "doc-1",
      sessionDid: "session-1",
      role: "owner" as const,
    },
    to: vi.fn((room: string) => ({
      emit: vi.fn((event: string, payload: unknown) => {
        toEmits.push({ room, event, payload });
      }),
    })),
  } as unknown as AppSocket & {
    _toEmits?: typeof toEmits;
  };

  (socket as any)._toEmits = toEmits;

  return socket;
}

describe("handleTerminateSession", () => {
  const authService = {
    verifyOwnerToken: vi.fn<[], Promise<string | null>>(),
  };

  const sessionManager = {
    getSession: vi.fn(),
    terminateSession: vi.fn(),
  };

  const deps: SocketHandlerDeps = {
    authService: authService as any,
    sessionManager: sessionManager as any,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when sessionDid is missing", async () => {
    const io = createFakeIo();
    const socket = createFakeSocket();
    const callback = vi.fn();

    await handleTerminateSession(
      deps,
      io,
      socket,
      {
        documentId: "doc-1",
        // @ts-expect-error deliberate missing sessionDid
        sessionDid: "",
        ownerToken: "owner-token",
        ownerAddress: "0x123" as Hex,
        contractAddress: "0xabc" as Hex,
      },
      callback
    );

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        status: false,
        statusCode: 400,
        error: "Session DID is required",
      })
    );
    expect(sessionManager.getSession).not.toHaveBeenCalled();
  });

  it("returns 404 when session is not found", async () => {
    const io = createFakeIo();
    const socket = createFakeSocket();
    const callback = vi.fn();

    sessionManager.getSession.mockResolvedValue(undefined);

    await handleTerminateSession(
      deps,
      io,
      socket,
      {
        documentId: "doc-1",
        sessionDid: "session-1",
        ownerToken: "owner-token",
        ownerAddress: "0x123" as Hex,
        contractAddress: "0xabc" as Hex,
      },
      callback
    );

    expect(sessionManager.getSession).toHaveBeenCalledWith("doc-1", "session-1");
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        status: false,
        statusCode: 404,
        error: "Session not found",
      })
    );
  });

  it("returns 401 when owner token does not match session owner", async () => {
    const io = createFakeIo();
    const socket = createFakeSocket();
    const callback = vi.fn();

    sessionManager.getSession.mockResolvedValue({
      documentId: "doc-1",
      sessionDid: "session-1",
      ownerDid: "did:key:owner",
    });

    authService.verifyOwnerToken.mockResolvedValue("did:key:other");

    await handleTerminateSession(
      deps,
      io,
      socket,
      {
        documentId: "doc-1",
        sessionDid: "session-1",
        ownerToken: "owner-token",
        ownerAddress: "0x123" as Hex,
        contractAddress: "0xabc" as Hex,
      },
      callback
    );

    expect(authService.verifyOwnerToken).toHaveBeenCalledWith(
      "owner-token",
      "0xabc",
      "0x123"
    );
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        status: false,
        statusCode: 401,
        error: "Unauthorized",
      })
    );
  });

  it("terminates session and broadcasts when owner token matches", async () => {
    const socketsInRoom = [
      {
        id: "peer-1",
        data: { authenticated: true },
        leave: vi.fn(),
      },
    ];

    const io = createFakeIo(socketsInRoom);
    const socket = createFakeSocket();
    const callback = vi.fn();

    sessionManager.getSession.mockResolvedValue({
      documentId: "doc-1",
      sessionDid: "session-1",
      ownerDid: "did:key:owner",
    });

    authService.verifyOwnerToken.mockResolvedValue("did:key:owner");

    await handleTerminateSession(
      deps,
      io,
      socket,
      {
        documentId: "doc-1",
        sessionDid: "session-1",
        ownerToken: "owner-token",
        ownerAddress: "0x123" as Hex,
        contractAddress: "0xabc" as Hex,
      },
      callback
    );

    // Session termination in session manager
    expect(sessionManager.terminateSession).toHaveBeenCalledWith("doc-1", "session-1");

    // All sockets in the room should leave and be unauthenticated
    expect(socketsInRoom[0].leave).toHaveBeenCalled();
    expect(socketsInRoom[0].data.authenticated).toBe(false);

    // The caller socket should broadcast /session/terminated
    const toEmits = (socket as any)._toEmits as {
      room: string;
      event: string;
      payload: unknown;
    }[];

    expect(toEmits.length).toBe(1);
    expect(toEmits[0]).toEqual({
      room: "session::doc-1__session-1",
      event: "/session/terminated",
      payload: { roomId: "doc-1" },
    });

    // Callback response
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        status: true,
        statusCode: 200,
        data: { message: "Session terminated" },
      })
    );
  });
});

