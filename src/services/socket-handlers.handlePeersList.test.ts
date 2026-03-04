import { describe, expect, it, vi, beforeEach } from "vitest";
import { handlePeersList, getRoomName } from "./socket-handlers";
// import { PeersListArgs } from "../types";
import type { AppServer, AppSocket, PeersListArgs } from "../types";

function createFakeIO(fetchSocketsResponse: any[] = []): AppServer {
  const fetchSocketsMock = vi.fn().mockResolvedValue(fetchSocketsResponse);

  return {
    in: vi.fn(() => ({
      fetchSockets: fetchSocketsMock,
    })),
  } as unknown as AppServer;
}

function createFakeSocket(
  broadcastOperator?: { emit: ReturnType<typeof vi.fn>},
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

  return {
    id: "socket-1",
    data,
    to: vi.fn(() => toReturn),
  } as unknown as AppSocket;
}

describe("tests peers list handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  })

  it("returns early when socket is not authenticated", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket(undefined, { authenticated: false });
    const fakeArgs: PeersListArgs = {};
    const fakeCallback= vi.fn();

    await handlePeersList(fakeIO, fakeSocket, fakeArgs, fakeCallback);

    expect(fakeIO.in).not.toHaveBeenCalled();
    expect(fakeCallback).toHaveBeenCalledWith({
      status: false,
      statusCode: 401,
      error: "Not authenticated or session not found",
    });
  });

  it("returns early when documentId is missing in socket data", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket(undefined, { documentId: "" });
    const fakeArgs: PeersListArgs = {};
    const fakeCallback= vi.fn();

    await handlePeersList(fakeIO, fakeSocket, fakeArgs, fakeCallback);

    expect(fakeIO.in).not.toHaveBeenCalled();
    expect(fakeCallback).toHaveBeenCalledWith({
      status: false,
      statusCode: 401,
      error: "Not authenticated or session not found",
    });
  });

  it("returns early when sessionDid is missing in socket data", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket(undefined, { sessionDid: "" });
    const fakeArgs: PeersListArgs = {};
    const fakeCallback = vi.fn();

    await handlePeersList(fakeIO, fakeSocket, fakeArgs, fakeCallback);

    expect(fakeIO.in).not.toHaveBeenCalled();
    expect(fakeCallback).toHaveBeenCalledWith({
      status: false,
      statusCode: 401,
      error: "Not authenticated or session not found",
    });
  });

  it("returns 500 when fetchSockets throws", async () => {
    const fetchSocketsMock = vi.fn().mockRejectedValue(new Error("fetch failed"));
    const fakeIO = {
      in: vi.fn(() => ({
        fetchSockets: fetchSocketsMock,
      })),
    } as unknown as AppServer;
    const fakeSocket = createFakeSocket();
    const fakeArgs: PeersListArgs = {};
    const fakeCallback = vi.fn();

    await handlePeersList(fakeIO, fakeSocket, fakeArgs, fakeCallback);

    expect(fakeCallback).toHaveBeenCalledWith({
      status: false,
      statusCode: 500,
      error: "Internal server error",
    });
  });

  it("returns peers list successfully", async () => {
    const fetchSocketsResponse = [
      { id: "socket-id-1" },
      { id: "socket-id-2" }
    ];
    const fakeIO = createFakeIO(fetchSocketsResponse);
    const fakeSocket = createFakeSocket();
    const fakeArgs: PeersListArgs = {};
    const fakeCallback = vi.fn();

    await handlePeersList(fakeIO, fakeSocket, fakeArgs, fakeCallback);

    const documentId = fakeArgs.documentId || fakeSocket.data.documentId;
    const roomName = getRoomName(documentId, fakeSocket.data.sessionDid);

    expect(fakeIO.in).toHaveBeenCalledWith(roomName);

    const peersData = ["socket-id-1", "socket-id-2"];
    expect(fakeCallback).toHaveBeenCalledWith({
      status: true,
      statusCode: 200,
      data: {
        peers: peersData,
      },
    })
  });
});