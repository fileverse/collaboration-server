import { beforeEach, it, describe, vi, expect } from "vitest";
import { handleAwareness } from "../../services/socket-handlers";
import type { AppServer, AppSocket } from "../../types";
import type { SocketData } from "../../types";

const defaultSocketData: SocketData = {
  documentId: "test-document-id",
  sessionDid: "test-session-did",
  role: "owner",
  authenticated: true,
  appType: "ddoc",
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
    disconnect: vi.fn(),
  } as unknown as AppSocket;
}

function createDeps(check = vi.fn().mockResolvedValue("bound")) {
  return {
    authService: {} as any,
    sessionManager: {
      getWorkspaceEditEnabled: vi.fn().mockResolvedValue(true),
      getCollabJoinEnabled: vi.fn().mockResolvedValue(true),
    } as any,
    mongodbStore: {} as any,
    editBoundCache: { check } as any,
  };
}

const flush = () => new Promise((r) => setImmediate(r));

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

    await handleAwareness(createDeps() as any, fakeIO, fakeSocket, fakeArgs);
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

    await handleAwareness(createDeps() as any, fakeIO, fakeSocket, fakeArgs);

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

    await expect(handleAwareness(createDeps() as any, fakeIO, fakeSocket as any, fakeArgs)).resolves.not.toThrow();
  });

  it("disconnects a revoked gp-actor editor on awareness traffic", async () => {
    const deps = createDeps(vi.fn().mockResolvedValue("unbound"));
    const socket = createFakeSocket(undefined, { role: "editor", rail: "gp", railKind: "gp-actor", actorHandle: "h1" });
    await handleAwareness(deps as any, createFakeIO(), socket, { documentId: "test-document-id", data: "x" } as any);
    await flush();
    expect((socket as any).to).toHaveBeenCalled(); // broadcast always goes out
    expect((socket as any).disconnect).toHaveBeenCalledWith(true);
  });

  it("never re-checks the owner", async () => {
    const check = vi.fn();
    const deps = createDeps(check);
    const socket = createFakeSocket(undefined, { role: "owner" });
    await handleAwareness(deps as any, createFakeIO(), socket, { documentId: "test-document-id", data: "x" } as any);
    await flush();
    expect(check).not.toHaveBeenCalled();
    expect((socket as any).disconnect).not.toHaveBeenCalled();
  });

  it("throttles: a second call within the interval does not re-check", async () => {
    const check = vi.fn().mockResolvedValue("bound");
    const deps = createDeps(check);
    const socket = createFakeSocket(undefined, { role: "editor", rail: "gp", railKind: "gp-actor", actorHandle: "h1" });
    await handleAwareness(deps as any, createFakeIO(), socket, { documentId: "test-document-id", data: "x" } as any);
    await handleAwareness(deps as any, createFakeIO(), socket, { documentId: "test-document-id", data: "x" } as any);
    await flush();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("leaves an admitted editor connected", async () => {
    const deps = createDeps(vi.fn().mockResolvedValue("bound"));
    const socket = createFakeSocket(undefined, { role: "editor", rail: "gp", railKind: "gp-actor", actorHandle: "h1" });
    await handleAwareness(deps as any, createFakeIO(), socket, { documentId: "test-document-id", data: "x" } as any);
    await flush();
    expect((socket as any).disconnect).not.toHaveBeenCalled();
  });
});
