import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RotationCoordinator } from "../../services/rotation-coordinator";

describe("RotationCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires cutover once all expected sockets ack, before the timeout", () => {
    const c = new RotationCoordinator(4000);
    const onCutover = vi.fn();
    c.begin({ documentId: "d", oldSessionDid: "s", epoch: 2, expected: ["a", "b"], onCutover });
    c.recordAck("d", "a");
    expect(onCutover).not.toHaveBeenCalled();
    c.recordAck("d", "b");
    expect(onCutover).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(onCutover).toHaveBeenCalledTimes(1); // not fired again by the timer
  });

  it("fires cutover on timeout even with a missing ack", () => {
    const c = new RotationCoordinator(4000);
    const onCutover = vi.fn();
    c.begin({ documentId: "d", oldSessionDid: "s", epoch: 2, expected: ["a", "b"], onCutover });
    c.recordAck("d", "a");
    vi.advanceTimersByTime(4000);
    expect(onCutover).toHaveBeenCalledTimes(1);
  });

  it("with no expected sockets, cuts over immediately", () => {
    const c = new RotationCoordinator(4000);
    const onCutover = vi.fn();
    c.begin({ documentId: "d", oldSessionDid: "s", epoch: 2, expected: [], onCutover });
    expect(onCutover).toHaveBeenCalledTimes(1);
  });

  it("ignores acks for an unknown or finished doc", () => {
    const c = new RotationCoordinator(4000);
    const onCutover = vi.fn();
    c.begin({ documentId: "d", oldSessionDid: "s", epoch: 2, expected: ["a"], onCutover });
    c.finish("d");
    c.recordAck("d", "a");
    expect(onCutover).not.toHaveBeenCalled();
  });

  it("isActive is true only while an unfired barrier exists", () => {
    const c = new RotationCoordinator(4000);
    expect(c.isActive("d")).toBe(false);
    c.begin({ documentId: "d", oldSessionDid: "s", epoch: 2, expected: ["a"], onCutover: vi.fn() });
    expect(c.isActive("d")).toBe(true);
    c.recordAck("d", "a"); // fires
    expect(c.isActive("d")).toBe(false);
  });

  it("a fired barrier does not leak: begin/fire works cleanly across two consecutive rotations for the same doc", () => {
    const c = new RotationCoordinator(4000);
    const onCutover1 = vi.fn();
    c.begin({ documentId: "d", oldSessionDid: "s1", epoch: 1, expected: ["a"], onCutover: onCutover1 });
    c.recordAck("d", "a"); // fires via ack-complete
    expect(onCutover1).toHaveBeenCalledTimes(1);
    expect(c.isActive("d")).toBe(false);

    const onCutover2 = vi.fn();
    c.begin({ documentId: "d", oldSessionDid: "s2", epoch: 2, expected: ["b"], onCutover: onCutover2 });
    expect(c.isActive("d")).toBe(true);
    vi.advanceTimersByTime(4000); // fires via timeout
    expect(onCutover2).toHaveBeenCalledTimes(1);
    expect(onCutover1).toHaveBeenCalledTimes(1); // unaffected
    expect(c.isActive("d")).toBe(false);

    // A late ack against the now-finished second barrier is a no-op.
    c.recordAck("d", "b");
    expect(onCutover2).toHaveBeenCalledTimes(1);
  });
});
