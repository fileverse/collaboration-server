import { beforeEach, it, describe, vi, expect } from "vitest";
import { handleAwareness } from "../../services/socket-handlers";
import type { AppServer, AppSocket } from "../../types";
import type { SocketData } from "../../types";

const defaultSocketData: SocketData = {
  documentId: "test-document-id",
  sessionDid: "test-session-did",
  role: "owner",
  authenticated: true,
};

function createFakeIO(): AppServer {
  return {} as unknown as AppServer;
}

function createFakeSocket(
  fakeBroadcastOperator?: { emit: ReturnType<typeof vi.fn> },
  dataOverrides?: Partial<SocketData>
): AppSocket {
  const op = fakeBroadcastOperator ?? { emit: vi.fn() };
  const data: SocketData = { ...defaultSocketData, ...dataOverrides };

  return {
    id: "socket-1",
    data,
    to: vi.fn(() => op),
  } as unknown as AppSocket;
}

describe('handleAwareness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns if socket is not authenticated", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket(undefined, { authenticated: false });
    const fakeArgs = {
      documentId: "",
      data: {},
      collaborationToken: "",
    };

    await handleAwareness(fakeIO, fakeSocket, fakeArgs);
    expect(fakeSocket.to).not.toHaveBeenCalled();
  });

  it("broadcasts awareness update to all participants in room", async () => {
    const fakeIO = createFakeIO();
    const fakeBroadcastOperator = { emit: vi.fn() };
    const fakeSocket = createFakeSocket(fakeBroadcastOperator);
    const fakeArgs = {
      documentId: "test-document-id",
      data: {
        "position": "AnOj8HhKtKwIwoMhASL3k9y7OKz1t8OLOxBhGgLobtL3__n__ZergaGXSI4+831Mn__n__mjnKm/6GcoUByss9zPvU6hMYQ4hcesVBcSluOAUctFSFNshQak+GHWAzptk4j4NmIIPtihoEmm0XBS3Sa7whQ+tIThoX9J4UGlb5MYk4oAuWgy0zfwU4vjfgqo+NyzcF/mlMDYOvdfnlLKWE/H7jI3V61Ddll6I+3d6oIRfSS2jruzvZn2slDC1Esg7S+a6Uw0LGUxOyY2dXEaaocB9qmuJG8OGw8D4u23mA+IiBfaqKggmt9OOkGiO3xVLr70XNqYfUpJbs8u5kPMuxWX5trT7L+asNitrsBplUsA0Kf4KaJBIQLmVSIWHtwyAaWNSxAPQPP7zW0Gm4VnuY4eTCAjU/iYlx3A==__n__5pXP2B5Nmt+xlOuzGOW9wA=="
      },
      collaborationToken: "test-collaborator-token",
    };

    await handleAwareness(fakeIO, fakeSocket, fakeArgs);

    const roomName = `session::${fakeArgs.documentId}__${fakeSocket.data.sessionDid}`;
    expect(fakeSocket.to).toHaveBeenCalledWith(roomName);
    expect(fakeBroadcastOperator.emit).toHaveBeenCalledWith("/document/awareness_update", {
      data: fakeArgs.data,
      roomId: fakeArgs.documentId,
    });
  });

  it("does not throw when an error occurs in awareness handler", async () => {
    const fakeIO = createFakeIO();
    const fakeSocket = createFakeSocket(undefined, { authenticated: true });
    Object.defineProperty(fakeSocket, "to", {
      get() {
        throw new Error("socket.to failed");
      },
    });
    const fakeArgs = {
      documentId: "test-document-id",
      data: {},
      collaborationToken: "",
    };

    await expect(handleAwareness(fakeIO, fakeSocket as any, fakeArgs)).resolves.not.toThrow();
  });
});