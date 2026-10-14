import { describe, it, expect, vi } from "vitest";
import { registerEventHandlers } from "../../services/socket-handlers";
import { authService } from "../../services/auth";
import type { AppServer, AppSocket } from "../../types";

function connectFakeSocket() {
  let onConnection: ((socket: AppSocket) => void) | undefined;
  const io = {
    on: vi.fn((event: string, handler: (socket: AppSocket) => void) => {
      if (event === "connection") onConnection = handler;
    }),
  } as unknown as AppServer;
  registerEventHandlers(io);

  const socket = { id: "socket-1", data: {}, emit: vi.fn(), on: vi.fn() };
  onConnection!(socket as unknown as AppSocket);
  return socket;
}

describe("/server/handshake", () => {
  it("sends the server DID and the server's current time in ms", () => {
    const before = Date.now();
    const socket = connectFakeSocket();
    const after = Date.now();

    const call = socket.emit.mock.calls.find(([event]) => event === "/server/handshake");
    expect(call).toBeDefined();
    const payload = call![1];
    expect(payload.server_did).toBe(authService.getServerDid());
    expect(typeof payload.server_time).toBe("number");
    expect(payload.server_time).toBeGreaterThanOrEqual(before);
    expect(payload.server_time).toBeLessThanOrEqual(after);
  });
});
