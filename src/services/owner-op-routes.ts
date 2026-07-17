import type { Request, Response } from "express";
import type { AppServer } from "../types/index";
import type { AuthService } from "./auth";
import type { SessionManager } from "./session-manager";
import type { MongoDBStore } from "./mongodb-store";
import type { EditBoundCache } from "./gate-epoch";
import { getRoomName } from "./socket-handlers";
import { Hex, isAddress } from "viem";
import { getPortalOwnerAddress, bustOwnerDidCacheForPortal } from "../utils/contract";

// Duplicated from socket-handlers.ts (not exported there); keep in sync if that changes.
function validateHexAddress(address: string | undefined, fieldName: string): address is Hex {
  if (!address || !isAddress(address)) {
    return false;
  }
  return true;
}

export interface OwnerOpDeps {
  authService: Pick<AuthService, "verifyOwnerOp">;
  sessionManager: Pick<
    SessionManager,
    "getSession" | "setCollabJoinEnabled" | "setWorkspaceEditEnabled" | "getNonTerminatedSessionsForDocument"
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
    let updated = 0;
    for (const sd of sessionDids) {
      if (await deps.sessionManager.setCollabJoinEnabled(documentId, sd, !!enabled)) updated++;
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

    res.status(200).json({ ok: true, updated });
  };
}

export function createWorkspaceEditTierHandler(deps: OwnerOpDeps, io: AppServer) {
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

    // Doc-wide, mirroring collab-join-enabled: the flag lives on every session so a joiner
    // reads it whatever session its roomKey derives.
    const targets = await deps.sessionManager.getNonTerminatedSessionsForDocument(documentId);
    const sessionDids = new Set<string>(targets.map((t) => t.sessionDid));
    sessionDids.add(sessionDid);
    let updated = 0;
    for (const sd of sessionDids) {
      if (await deps.sessionManager.setWorkspaceEditEnabled(documentId, sd, !!enabled)) updated++;
    }

    if (enabled === false) {
      // Synchronous revocation: drop live workspace-rail sockets only — public/GP editors
      // are governed by their own rails.
      for (const sd of sessionDids) {
        const roomName = getRoomName(documentId, sd);
        const sockets = await io.in(roomName).fetchSockets();
        for (const s of sockets) {
          if (s.data.rail === "workspace") s.disconnect(true);
        }
      }
    }

    res.status(200).json({ ok: true, updated });
  };
}

/** Targeted eviction of specific gp-actor handles: bust the per-actor edit-bound cache,
 *  then drop the matching live sockets across every session room of the doc. Co-editors
 *  with other handles are untouched. */
export function createEvictEditActorsHandler(
  deps: OwnerOpDeps & { editBoundCache: EditBoundCache },
  io: AppServer
) {
  return async (req: Request, res: Response): Promise<void> => {
    const documentId = req.params.documentId;
    const { sessionDid, handles, identityToken, identityContractAddress, ownerToken, ownerAddress, portalAddress } = req.body || {};

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

    const list = Array.isArray(handles) ? handles.filter((h) => typeof h === "string") : [];
    deps.editBoundCache.evict(documentId, list);

    let dropped = 0;
    if (list.length > 0) {
      const handleSet = new Set<string>(list);
      const targets = await deps.sessionManager.getNonTerminatedSessionsForDocument(documentId);
      const sessionDids = new Set<string>(targets.map((t) => t.sessionDid));
      sessionDids.add(sessionDid);
      for (const sd of sessionDids) {
        const sockets = await io.in(getRoomName(documentId, sd)).fetchSockets();
        for (const s of sockets) {
          if (s.data.railKind === "gp-actor" && s.data.actorHandle && handleSet.has(s.data.actorHandle)) {
            s.disconnect(true);
            dropped++;
          }
        }
      }
    }

    res.status(200).json({ ok: true, evicted: list.length, dropped });
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

export function createMirrorReadHandler(deps: { mongodbStore: Pick<MongoDBStore, "getLatestMirror"> }) {
  return async (req: Request, res: Response): Promise<void> => {
    // Open read: the payload is fileKey-ciphertext, useless without the key (public → linkKey;
    // private → gate/appLock). Access control is the key, not this endpoint.
    const documentId = req.params.documentId;
    const mirror = await deps.mongodbStore.getLatestMirror(documentId);
    if (!mirror) {
      res.status(404).json({ error: "No mirror snapshot" });
      return;
    }
    res.status(200).json(mirror);
  };
}

export function createEvictWorkspaceMemberHandler(
  deps: {
    authService: Pick<AuthService, "verifyOwnerToken">;
    sessionManager: Pick<SessionManager, "getNonTerminatedSessionsForPortal">;
  },
  io: AppServer
) {
  return async (req: Request, res: Response): Promise<void> => {
    const portalAddress = req.params.portalAddress as Hex;
    const { memberIdentityDid, ownerToken, ownerAddress } = req.body || {};

    if (
      !validateHexAddress(portalAddress, "portalAddress") ||
      !validateHexAddress(ownerAddress, "ownerAddress")
    ) {
      res.status(400).json({ error: "Invalid portal or owner address" });
      return;
    }
    if (typeof memberIdentityDid !== "string" || !memberIdentityDid.startsWith("did:")) {
      res.status(400).json({ error: "memberIdentityDid must be a DID string" });
      return;
    }
    if (typeof ownerToken !== "string" || !ownerToken) {
      res.status(400).json({ error: "ownerToken is required" });
      return;
    }

    // Owner-only: the presented address must BE the portal creator
    // (Portal.owner() = the workspace Admin Sub-Agent). collaboratorKeys(MSA)
    // is the shared member DID every member can sign for — it lives at a
    // different address and never passes this gate.
    const portalOwner = await getPortalOwnerAddress(portalAddress);
    if (!portalOwner || portalOwner.toLowerCase() !== String(ownerAddress).toLowerCase()) {
      res.status(403).json({ error: "Not the portal owner" });
      return;
    }
    const ownerDid = await deps.authService.verifyOwnerToken(
      ownerToken,
      portalAddress,
      ownerAddress as Hex
    );
    if (!ownerDid) {
      res.status(403).json({ error: "Owner token verification failed" });
      return;
    }

    bustOwnerDidCacheForPortal(portalAddress);

    const sessions = await deps.sessionManager.getNonTerminatedSessionsForPortal(portalAddress);
    let dropped = 0;
    for (const s of sessions) {
      const roomName = getRoomName(s.documentId, s.sessionDid);
      const sockets = await io.in(roomName).fetchSockets();
      for (const sock of sockets) {
        if (sock.data.actorIdentityDid === memberIdentityDid) {
          sock.disconnect(true);
          dropped++;
        }
      }
    }

    res.status(200).json({ ok: true, sessions: sessions.length, dropped });
  };
}
