// Regression: removing one editor of a private doc kicked the SURVIVING co-editor.
//
// The §8A cleanup replaced the per-actor-handle live re-check with a DOC-WIDE epoch floor
// (editEpoch >= minEditEpoch). On removal the client evicts the removed actor with the bumped
// gateEpoch, stamping minEditEpoch doc-wide BEFORE the make-before-break rotation hands survivors
// a fresh-epoch editUcan at cutover. In the gap every surviving co-editor (admitted at the old
// epoch) failed the doc-wide check and was disconnected — missing the one-shot /session/cutover
// and stranded until a full refresh. An `isActive`-grace patch could not close it (the floor is
// stamped at evict, strictly before /rotate calls rotationCoordinator.begin()).
//
// Fix: the LIVE re-check is per-handle again. A gp-actor is kicked iff ITS OWN handle was evicted
// at an epoch above the one it joined under — the doc-wide floor is consulted ONLY at JOIN. A
// survivor's handle is never evicted, so it can never be floor-kicked, in any rotation window.
// See docs/architecture/edit-permission.md (roomKey rotation / make-before-break cutover).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { isStillAdmitted, resolveEditAdmission } from "../../services/socket-handlers";
import type { AppSocket, SocketData } from "../../types/index";
import type { SocketHandlerDeps } from "../../services/socket-handlers.deps";

const DOC = "doc-under-removal";
const OLD_EPOCH = 5; // admitted at the pre-removal edit epoch
const EVICT_EPOCH = 6; // gate bumped the epoch on removing an editor; evict denylisted the handle here

const SURVIVOR = "survivor-handle";
const REMOVED = "removed-handle";

function gpActorSocket(editEpoch: number | undefined, actorHandle: string | undefined): AppSocket {
  const data: SocketData = {
    documentId: DOC,
    sessionDid: "old-session-did",
    role: "editor",
    authenticated: true,
    appType: "ddoc",
    rail: "gp",
    railKind: "gp-actor",
    actorHandle,
    editEpoch,
  };
  return { id: "some-socket", data } as unknown as AppSocket;
}

// The only handle in the denylist is REMOVED@EVICT_EPOCH — everything else is unlisted.
function depsWithDenylist(): SocketHandlerDeps {
  return {
    authService: {} as SocketHandlerDeps["authService"],
    sessionManager: {} as SocketHandlerDeps["sessionManager"],
    mongodbStore: {
      getEvictedHandleEpoch: vi
        .fn()
        .mockImplementation(async (_doc: string, handle: string) =>
          handle === REMOVED ? EVICT_EPOCH : undefined
        ),
    } as unknown as SocketHandlerDeps["mongodbStore"],
  };
}

describe("isStillAdmitted — per-handle denylist (surviving co-editor is never floor-kicked)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // THE REGRESSION. Survivor admitted at the OLD epoch, its handle never evicted → admitted, with
  // no notion of an in-flight rotation. Closes every timing window the isActive grace left open.
  it("admits a below-epoch surviving co-editor whose handle was not evicted", async () => {
    const admitted = await isStillAdmitted(gpActorSocket(OLD_EPOCH, SURVIVOR), depsWithDenylist());
    expect(admitted).toBe(true);
  });

  // Removed actor: its handle IS denylisted at EVICT_EPOCH and its socket joined below that → kicked.
  it("kicks a socket whose handle was evicted at an epoch above its admitted one", async () => {
    const admitted = await isStillAdmitted(gpActorSocket(OLD_EPOCH, REMOVED), depsWithDenylist());
    expect(admitted).toBe(false);
  });

  // Re-added actor: same handle, but re-enrolled and re-joined at/above the evict epoch → admitted.
  // Mirrors the old edit-bound poll re-admitting a re-added member.
  it("admits a re-added actor that re-joined at/above its evict epoch", async () => {
    const atFloor = await isStillAdmitted(gpActorSocket(EVICT_EPOCH, REMOVED), depsWithDenylist());
    const aboveFloor = await isStillAdmitted(gpActorSocket(EVICT_EPOCH + 1, REMOVED), depsWithDenylist());
    expect(atFloor).toBe(true);
    expect(aboveFloor).toBe(true);
  });

  // Fail closed: a gp-actor missing its admitted editEpoch or handle cannot be evaluated.
  it("fails closed for a gp-actor with no admitted editEpoch or handle", async () => {
    expect(await isStillAdmitted(gpActorSocket(undefined, SURVIVOR), depsWithDenylist())).toBe(false);
    expect(await isStillAdmitted(gpActorSocket(OLD_EPOCH, undefined), depsWithDenylist())).toBe(false);
  });

  // Security invariant: JOIN admission stays strict on the DOC-WIDE floor — the per-handle live
  // check does not weaken it. The removed actor's below-floor editUcan is rejected at any fresh
  // handshake, so it cannot exploit the survivor's live grace to REJOIN.
  it("resolveEditAdmission still rejects a below-floor editUcan at JOIN", async () => {
    const deps = {
      authService: {
        verifyEditUcan: vi
          .fn()
          .mockResolvedValue({ kind: "actor", epoch: OLD_EPOCH, editHandle: REMOVED }),
      },
      mongodbStore: { getMinEditEpoch: vi.fn().mockResolvedValue(EVICT_EPOCH) },
    };

    const admission = await resolveEditAdmission(deps as never, "removed-actor-edit-ucan", DOC);

    expect(admission).toEqual({ ok: false });
  });
});
