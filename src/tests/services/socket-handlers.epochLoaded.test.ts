import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleEpochLoaded } from "../../services/socket-handlers";
import { rotationCoordinator } from "../../services/rotation-coordinator";
import { ErrorCode } from "../../types/index";
import type { AppSocket, SocketData } from "../../types/index";

vi.mock("../../services/rotation-coordinator", () => ({
  rotationCoordinator: { recordAck: vi.fn() },
}));

const defaultSocketData: SocketData = {
  documentId: "test-document-id",
  sessionDid: "test-session-did",
  role: "editor",
  authenticated: true,
  appType: "ddoc",
};

function createFakeSocket(dataOverrides?: Partial<SocketData>): AppSocket {
  const data: SocketData = { ...defaultSocketData, ...dataOverrides };
  return {
    id: "socket-1",
    data,
  } as unknown as AppSocket;
}

describe("handleEpochLoaded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records the ack and acks { ok: true } for an authenticated socket", () => {
    const socket = createFakeSocket({
      authenticated: true,
      documentId: "test-document-id",
      sessionDid: "test-session-did",
    });
    const callback = vi.fn();
    const args = { documentId: "test-document-id", epoch: 3 };

    handleEpochLoaded(socket, args, callback);

    expect(rotationCoordinator.recordAck).toHaveBeenCalledWith("test-document-id", "socket-1");
    expect(callback).toHaveBeenCalledWith({
      status: true,
      statusCode: 200,
      data: { ok: true },
    });
  });

  it("rejects an unauthenticated socket with NOT_AUTHENTICATED and never records an ack", () => {
    const socket = createFakeSocket({ authenticated: false });
    const callback = vi.fn();
    const args = { documentId: "test-document-id", epoch: 3 };

    handleEpochLoaded(socket, args, callback);

    expect(rotationCoordinator.recordAck).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({
      status: false,
      statusCode: 401,
      error: "Not authenticated or session not found",
      errorCode: ErrorCode.NOT_AUTHENTICATED,
    });
  });
});
