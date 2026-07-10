import type { Request, Response } from "express";
import type { AppServer } from "../types/index";
import type { AuthService } from "./auth";
import type { SessionManager } from "./session-manager";
import type { MongoDBStore } from "./mongodb-store";
import { getRoomName } from "./socket-handlers";
import { Hex } from "viem";

export interface OwnerOpDeps {
  authService: Pick<AuthService, "verifyOwnerOp">;
  sessionManager: Pick<
    SessionManager,
    "getSession" | "setCollabJoinEnabled" | "getNonTerminatedSessionsForDocument"
  >;
}

export function createCollabJoinEnabledHandler(deps: OwnerOpDeps, io: AppServer) {
  return async (req: Request, res: Response): Promise<void> => {
    const documentId = req.params.documentId;
    const { sessionDid, enabled, identityToken, identityContractAddress, ownerToken, ownerAddress, portalAddress } = req.body || {};

    const session = await deps.sessionManager.getSession(documentId, sessionDid);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const authorized = await deps.authService.verifyOwnerOp({
      ddocId: documentId,
      boundOwnerIdentityDid: (session as any).ownerIdentityDid ?? null,
      boundOwnerDid: session.ownerDid ?? null,
      identityToken, identityContractAddress: identityContractAddress as Hex,
      ownerToken, ownerAddress: ownerAddress as Hex, portalAddress: portalAddress as Hex,
    });
    if (!authorized) {
      res.status(403).json({ error: "Not the document owner" });
      return;
    }

    // Apply to EVERY non-terminated session of the doc, not just the client-supplied
    // sessionDid: a joiner derives the current session from its own roomKey and reads that
    // session's flag on `/auth`, so a flag left on a stale session is a silent re-join hole.
    // Safe doc-wide: this op only drops non-owner sockets and the flag is a reversible
    // join-gate, so any proven owner may close the whole doc without harming a co-owner.
    const targets = await deps.sessionManager.getNonTerminatedSessionsForDocument(documentId);
    const sessionDids = new Set<string>(targets.map((t) => t.sessionDid));
    sessionDids.add(sessionDid);
    for (const sd of sessionDids) {
      await deps.sessionManager.setCollabJoinEnabled(documentId, sd, !!enabled);
    }

    if (enabled === false) {
      // Force-drop live non-owner sockets across ALL of the doc's rooms (stop-share teeth).
      // `fetchSockets()` reaches every socket in a room (across instances when the Redis
      // adapter is on), so `.disconnect(true)` drops it wherever it lives.
      for (const sd of sessionDids) {
        const roomName = getRoomName(documentId, sd);
        const sockets = await io.in(roomName).fetchSockets();
        for (const s of sockets) {
          if (s.data.role !== "owner") s.disconnect(true);
        }
      }
    }

    res.status(200).json({ ok: true });
  };
}

export interface ListMyDocumentsDeps {
  authService: Pick<AuthService, "verifyIdentityToken">;
  mongodbStore: Pick<MongoDBStore, "listDocumentsForOwner">;
}

export function createListMyDocumentsHandler(deps: ListMyDocumentsDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const { identityToken, identityContractAddress, portalAddress } = req.body || {};

    // Path 1 — identity: the capability binds the portalAddress (a discovery scope, not a single ddocId).
    if (identityToken && identityContractAddress && portalAddress) {
      const signingDid = await deps.authService.verifyIdentityToken(identityToken, identityContractAddress, portalAddress);
      if (signingDid) {
        const documents = await deps.mongodbStore.listDocumentsForOwner({ ownerIdentityDid: signingDid });
        res.status(200).json({ documents });
        return;
      }
    }

    // Path 2 — portal owner: ⚠ DEFERRED in v1 (same member-forgeable `collaboratorKeys` flaw as
    // verifyOwnerOp path 2 — a shared workspaceCollabDid every member holds). Recovery is identity-scoped
    // in v1: a caller recovers the docs bound to their OWN signingDid. Workspace-wide portal-owner recovery
    // waits on the ASA-owner proof.

    res.status(401).json({ error: "Authentication failed" });
  };
}

export function createDeleteDocumentHandler(deps: {
  authService: Pick<AuthService, "verifyOwnerOp">;
  sessionManager: Pick<SessionManager, "getSession">;
  mongodbStore: Pick<MongoDBStore, "purgeDocument">;
}) {
  return async (req: Request, res: Response): Promise<void> => {
    const documentId = req.params.documentId;
    const { sessionDid, identityToken, identityContractAddress, ownerToken, ownerAddress, portalAddress } = req.body || {};

    const session = await deps.sessionManager.getSession(documentId, sessionDid);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // Delete disabled without an owner-of-record.
    if (!session.ownerIdentityDid && !session.ownerDid) {
      res.status(403).json({ error: "No owner-of-record; delete disabled" });
      return;
    }

    const authorized = await deps.authService.verifyOwnerOp({
      ddocId: documentId,
      boundOwnerIdentityDid: session.ownerIdentityDid ?? null,
      boundOwnerDid: session.ownerDid ?? null,
      identityToken, identityContractAddress, ownerToken, ownerAddress, portalAddress,
    });
    if (!authorized) {
      res.status(403).json({ error: "Not the document owner" });
      return;
    }

    await deps.mongodbStore.purgeDocument(documentId);
    res.status(200).json({ ok: true });
  };
}
