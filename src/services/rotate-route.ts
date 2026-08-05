import type { Request, Response } from "express";
import type { AppServer } from "../types/index";
import type { AuthService } from "./auth";
import type { SessionManager } from "./session-manager";
import type { MongoDBStore } from "./mongodb-store";
import type { RotationCoordinator } from "./rotation-coordinator";
import { getRoomName } from "./socket-handlers";
import { Hex } from "viem";

const T_DRAIN_MS = 10_000;

export interface RotateDeps {
  authService: Pick<AuthService, "verifyOwnerOp">;
  sessionManager: Pick<SessionManager, "getSession" | "createSession">;
  mongodbStore: Pick<MongoDBStore, "setMinEditEpoch">;
  rotationCoordinator: Pick<RotationCoordinator, "begin" | "isActive">;
  terminateOldSession: (documentId: string, sessionDid: string) => Promise<void>;
}

export function createRotateSessionHandler(deps: RotateDeps, io: AppServer) {
  return async (req: Request, res: Response): Promise<void> => {
    const documentId = req.params.documentId;
    const {
      oldSessionDid, newSessionDid, payload, gateEpoch,
      identityToken, ownerToken, ownerAddress, portalAddress,
    } = req.body || {};

    if (
      typeof oldSessionDid !== "string" ||
      typeof newSessionDid !== "string" ||
      typeof payload !== "string" ||
      !Number.isInteger(gateEpoch) ||
      gateEpoch < 0
    ) {
      res.status(400).json({ error: "oldSessionDid, newSessionDid, payload and a non-negative integer gateEpoch are required" });
      return;
    }

    // One rotation per doc at a time; the gate's epoch CAS is the cross-device backstop.
    // See docs/architecture/gp-semaphore.md.
    if (deps.rotationCoordinator.isActive(documentId)) {
      res.status(409).json({ error: "Rotation already in progress" });
      return;
    }

    const oldSession = await deps.sessionManager.getSession(documentId, oldSessionDid);
    if (!oldSession) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const authorized = await deps.authService.verifyOwnerOp({
      ddocId: documentId,
      boundOwnerIdentityDid: (oldSession as any).ownerIdentityDid ?? null,
      boundOwnerDid: oldSession.ownerDid ?? null,
      identityToken,
      ownerToken, ownerAddress: ownerAddress as Hex, portalAddress: portalAddress as Hex,
    });
    if (!authorized) {
      res.status(403).json({ error: "Not the document owner" });
      return;
    }

    // Create the post-rotation session WITHOUT the owner-/auth takeover sweep, so the old
    // session stays live through the make-before-break cutover. Idempotent on retry.
    if (!(await deps.sessionManager.getSession(documentId, newSessionDid))) {
      await deps.sessionManager.createSession({
        documentId,
        sessionDid: newSessionDid,
        ownerDid: oldSession.ownerDid,
        ownerIdentityDid: (oldSession as any).ownerIdentityDid ?? null,
        portalAddress: oldSession.portalAddress ?? undefined,
        collabJoinEnabled: (oldSession as any).collabJoinEnabled ?? false,
        roomInfo: oldSession.roomInfo,
        appType: oldSession.appType ?? "ddoc",
      } as any);
    }

    await deps.mongodbStore.setMinEditEpoch(documentId, gateEpoch);

    const oldRoom = getRoomName(documentId, oldSessionDid);
    io.to(oldRoom).emit("/session/epoch_available", { roomId: documentId, epoch: gateEpoch, payload });

    // Admitted editors always have a rail set at JOIN; a role-capped read-only socket
    // (e.g. the owner's headless joinOnly read) is not, and must not stall the barrier.
    const expected = (await io.in(oldRoom).fetchSockets())
      .filter((s) => s.data.role !== "owner" && !!s.data.rail)
      .map((s) => s.id);

    deps.rotationCoordinator.begin({
      documentId,
      oldSessionDid,
      epoch: gateEpoch,
      expected,
      onCutover: () => {
        io.to(oldRoom).emit("/session/cutover", { roomId: documentId, epoch: gateEpoch });
        setTimeout(() => {
          void deps.terminateOldSession(documentId, oldSessionDid)
            .catch((e) => console.error("rotate terminate error:", e));
        }, T_DRAIN_MS);
      },
    });

    res.status(200).json({ ok: true, newSessionDid, liveEditors: expected.length });
  };
}
