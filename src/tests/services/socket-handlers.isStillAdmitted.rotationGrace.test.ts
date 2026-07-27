// Regression: removing one editor of a private doc kicks the SURVIVING co-editor.
//
// The §8A cleanup replaced the per-actor-handle live re-check (editBoundCache.check(doc, handle))
// with a doc-wide epoch floor (editEpoch >= minEditEpoch). On removal the client evicts the removed
// actor with the bumped gateEpoch, which stamps minEditEpoch doc-wide BEFORE the make-before-break
// rotation hands survivors a fresh-epoch editUcan at cutover. In the gap every surviving co-editor
// (admitted at the old epoch) now fails isStillAdmitted and is disconnected — so it misses the
// one-shot /session/cutover and is stranded until a full refresh re-mints its editUcan.
//
// The floor is correct at JOIN (it locks out the removed actor's stale editUcan). It must NOT kick
// an already-admitted survivor while a make-before-break rotation for the doc is in flight.
// See docs/architecture/edit-permission.md (roomKey rotation / make-before-break cutover).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { isStillAdmitted, resolveEditAdmission } from "../../services/socket-handlers";
import { rotationCoordinator } from "../../services/rotation-coordinator";
import type { AppSocket, SocketData } from "../../types/index";
import type { SocketHandlerDeps } from "../../services/socket-handlers.deps";

vi.mock("../../services/rotation-coordinator", () => ({
  rotationCoordinator: { isActive: vi.fn() },
}));

const DOC = "doc-under-removal";
const OLD_EPOCH = 5; // survivor was admitted at the pre-removal edit epoch
const NEW_FLOOR = 6; // gate bumped the epoch on removing the other editor; evict stamped this floor

function gpActorSocket(editEpoch: number | undefined): AppSocket {
  const data: SocketData = {
    documentId: DOC,
    sessionDid: "old-session-did",
    role: "editor",
    authenticated: true,
    appType: "ddoc",
    rail: "gp",
    railKind: "gp-actor",
    actorHandle: "survivor-handle",
    editEpoch,
  };
  return { id: "survivor-socket", data } as unknown as AppSocket;
}

function depsWithFloor(floor: number): SocketHandlerDeps {
  return {
    authService: {} as SocketHandlerDeps["authService"],
    sessionManager: {} as SocketHandlerDeps["sessionManager"],
    mongodbStore: {
      getMinEditEpoch: vi.fn().mockResolvedValue(floor),
    } as unknown as SocketHandlerDeps["mongodbStore"],
  };
}

describe("isStillAdmitted — surviving co-editor must ride the rotation cutover, not get kicked", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // THE REGRESSION. Survivor is below the freshly-stamped floor, but a make-before-break rotation
  // for this doc is active — it must stay admitted so its next update/awareness heartbeat does not
  // disconnect it before cutover re-auths it at the new epoch.
  it("admits a below-floor gp-actor while a make-before-break rotation is active", async () => {
    (rotationCoordinator.isActive as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const admitted = await isStillAdmitted(gpActorSocket(OLD_EPOCH), depsWithFloor(NEW_FLOOR));

    expect(admitted).toBe(true);
  });

  // Guard: no rotation in flight → a below-floor socket is genuinely stale and IS kicked. Proves the
  // fix is scoped to the rotation window, not a blanket floor bypass.
  it("kicks a below-floor gp-actor when no rotation is active", async () => {
    (rotationCoordinator.isActive as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const admitted = await isStillAdmitted(gpActorSocket(OLD_EPOCH), depsWithFloor(NEW_FLOOR));

    expect(admitted).toBe(false);
  });

  // Guard: at/above the floor is always admitted, rotation or not.
  it("admits a gp-actor at/above the floor regardless of rotation state", async () => {
    (rotationCoordinator.isActive as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const admitted = await isStillAdmitted(gpActorSocket(NEW_FLOOR), depsWithFloor(NEW_FLOOR));

    expect(admitted).toBe(true);
  });

  // Guard: an unbound socket (no editEpoch) still fails closed.
  it("fails closed for a gp-actor with no admitted editEpoch", async () => {
    (rotationCoordinator.isActive as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const admitted = await isStillAdmitted(gpActorSocket(undefined), depsWithFloor(NEW_FLOOR));

    expect(admitted).toBe(false);
  });

  // Security invariant: JOIN admission stays strict. The removed actor cannot exploit the survivor
  // grace to REJOIN mid-rotation — resolveEditAdmission rejects a below-floor editUcan even while a
  // rotation is active (the grace only spares already-admitted live sockets, never a fresh handshake).
  it("resolveEditAdmission rejects a below-floor editUcan even during an active rotation", async () => {
    (rotationCoordinator.isActive as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const deps = {
      authService: {
        verifyEditUcan: vi
          .fn()
          .mockResolvedValue({ kind: "actor", epoch: OLD_EPOCH, editHandle: "removed-handle" }),
      },
      mongodbStore: { getMinEditEpoch: vi.fn().mockResolvedValue(NEW_FLOOR) },
    };

    const admission = await resolveEditAdmission(deps as never, "removed-actor-edit-ucan", DOC);

    expect(admission).toEqual({ ok: false });
  });
});
