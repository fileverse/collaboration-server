import type { Request, Response } from "express";
import type { AppServer } from "../types/index";
import type { AuthService } from "./auth";
import type { SessionManager } from "./session-manager";
import type { MongoDBStore } from "./mongodb-store";
import { getRoomName } from "./socket-handlers";
import { Hex, isAddress } from "viem";
import { getPortalOwnerAddress, bustOwnerDidCacheForPortal } from "../utils/contract";
import { logger } from "./logger";

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

// Absence-vs-skew evidence for the 404 class: "no sessions at all" means the owner
// socket never established the room; a non-empty list means the client derived a
// sessionDid the server doesn't have (stale/rotated roomKey).
async function logSessionNotFound(
  op: string,
  documentId: string,
  sessionDid: string | undefined,
  sessionManager: Pick<SessionManager, "getNonTerminatedSessionsForDocument">
): Promise<void> {
  try {
    const others = await sessionManager.getNonTerminatedSessionsForDocument(documentId);
    logger.warn(
      `[owner-op:${op}] session not found doc=${documentId} did=${sessionDid} nonTerminated=[${others.map((t) => t.sessionDid).join(",")}]`
    );
  } catch {
    logger.warn(`[owner-op:${op}] session not found doc=${documentId} did=${sessionDid}`);
  }
}

export function createCollabJoinEnabledHandler(deps: OwnerOpDeps, io: AppServer) {
  return async (req: Request, res: Response): Promise<void> => {
    const documentId = req.params.documentId;
    const { sessionDid, enabled, identityToken, ownerToken, ownerAddress, portalAddress } = req.body || {};

    const session = await deps.sessionManager.getSession(documentId, sessionDid);
    if (!session) {
      await logSessionNotFound("collab-join-enabled", documentId, sessionDid, deps.sessionManager);
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const authorized = await deps.authService.verifyOwnerOp({
      ddocId: documentId,
      boundOwnerIdentityDid: (session as any).ownerIdentityDid ?? null,
      boundOwnerDid: session.ownerDid ?? null,
      identityToken,
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
    const { sessionDid, enabled, identityToken, ownerToken, ownerAddress, portalAddress } = req.body || {};

    const session = await deps.sessionManager.getSession(documentId, sessionDid);
    if (!session) {
      await logSessionNotFound("workspace-edit-tier", documentId, sessionDid, deps.sessionManager);
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const authorized = await deps.authService.verifyOwnerOp({
      ddocId: documentId,
      boundOwnerIdentityDid: (session as any).ownerIdentityDid ?? null,
      boundOwnerDid: session.ownerDid ?? null,
      identityToken,
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

/** Targeted eviction of specific gp-actor handles: stamp the epoch floor, then drop the
 *  matching live sockets across every session room of the doc. Co-editors with other handles
 *  are untouched. The offline minEditEpoch floor (plus rotation) supersedes the removed cache. */
export function createEvictEditActorsHandler(
  deps: OwnerOpDeps & { mongodbStore: Pick<MongoDBStore, "setMinEditEpoch" | "setEvictedHandles"> },
  io: AppServer
) {
  return async (req: Request, res: Response): Promise<void> => {
    const documentId = req.params.documentId;
    const { sessionDid, handles, identityToken, ownerToken, ownerAddress, portalAddress } = req.body || {};

    const session = await deps.sessionManager.getSession(documentId, sessionDid);
    if (!session) {
      await logSessionNotFound("evict-edit-actors", documentId, sessionDid, deps.sessionManager);
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const authorized = await deps.authService.verifyOwnerOp({
      ddocId: documentId,
      boundOwnerIdentityDid: (session as any).ownerIdentityDid ?? null,
      boundOwnerDid: session.ownerDid ?? null,
      identityToken,
      ownerToken, ownerAddress: ownerAddress as Hex, portalAddress: portalAddress as Hex,
    });
    if (!authorized) {
      res.status(403).json({ error: "Not the document owner" });
      return;
    }

    const list = Array.isArray(handles) ? handles.filter((h) => typeof h === "string") : [];

    // Stamp the floor even when rotation is deferred, so a stale-UCAN rejoin is blocked
    // immediately rather than waiting on the next epoch bump to propagate. gateEpoch is
    // optional here — an invalid value is silently skipped rather than failing the evict.
    if (Number.isInteger(req.body?.gateEpoch) && req.body.gateEpoch >= 0) {
      await deps.mongodbStore.setMinEditEpoch(documentId, req.body.gateEpoch);
      // Denylist the evicted handles at this epoch so the LIVE per-actor re-check kicks any of
      // their sockets the targeted sweep below missed — without touching surviving co-editors.
      if (list.length > 0) await deps.mongodbStore.setEvictedHandles(documentId, list, req.body.gateEpoch);
    }

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
    const { identityToken, portalAddress } = req.body || {};

    // Path 1 — identity: the capability binds the portalAddress (a discovery scope, not a single ddocId).
    if (identityToken && portalAddress) {
      const signingDid = await deps.authService.verifyIdentityToken(identityToken, portalAddress);
      if (signingDid) {
        // portalAddress is safe to filter on: verifyIdentityToken only returns a signingDid
        // when the UCAN was signed for exactly this hierPart.
        const documents = await deps.mongodbStore.listDocumentsForOwner({
          ownerIdentityDid: signingDid,
          portalAddress,
        });
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
  mongodbStore: Pick<MongoDBStore, "tombstoneDocument">;
}) {
  return async (req: Request, res: Response): Promise<void> => {
    const documentId = req.params.documentId;
    const { sessionDid, identityToken, ownerToken, ownerAddress, portalAddress } = req.body || {};

    const session = await deps.sessionManager.getSession(documentId, sessionDid);
    if (!session) {
      logger.warn(`[owner-op:delete] session not found doc=${documentId} did=${sessionDid}`);
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
      identityToken, ownerToken, ownerAddress, portalAddress,
    });
    if (!authorized) {
      res.status(403).json({ error: "Not the document owner" });
      return;
    }

    // Reversible tombstone, not a purge — see docs/architecture/edit-permission.md.
    // Irreversible purge is driven only by the on-chain webhook + grace job.
    await deps.mongodbStore.tombstoneDocument(documentId, "owner-delete");
    res.status(200).json({ ok: true });
  };
}

export function createMirrorReadHandler(deps: { mongodbStore: Pick<MongoDBStore, "getLatestMirror" | "isTombstoned"> }) {
  return async (req: Request, res: Response): Promise<void> => {
    // Open read: the payload is fileKey-ciphertext, useless without the key (public → linkKey;
    // private → gate/appLock). Access control is the key, not this endpoint.
    const documentId = req.params.documentId;
    // Tombstoned docs serve 404 — see docs/architecture/edit-permission.md.
    if (await deps.mongodbStore.isTombstoned(documentId)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const mirror = await deps.mongodbStore.getLatestMirror(documentId);
    if (!mirror) {
      res.status(404).json({ error: "No mirror snapshot" });
      return;
    }
    res.status(200).json(mirror);
  };
}

/** Open read: existence only (same trust model as the mirror GET). */
export function createShareContextHandler(deps: {
  mongodbStore: Pick<MongoDBStore, "getShareContext">;
  sessionManager?: Pick<SessionManager, "getSession" | "getLegacyRtcVerdict">;
}) {
  return async (req: Request, res: Response): Promise<void> => {
    // Express 4 doesn't catch async rejections — an unhandled store error
    // would hang the request (and the client has no timeout-free fallback).
    try {
      const ctx = await deps.mongodbStore.getShareContext(req.params.documentId);
      // Optional probe: same lookup the owner-ops open with, so `sessionExists`
      // answers exactly "will an owner-op on this sessionDid find the session".
      const sessionDid = req.query?.sessionDid;
      if (typeof sessionDid === "string" && sessionDid && deps.sessionManager) {
        const session = await deps.sessionManager.getSession(req.params.documentId, sessionDid);
        // Omitted (not false) when unknowable — the client treats absence as
        // "not legacy" so old servers and fresh deployments fail closed.
        const legacyRtc = session
          ? await deps.sessionManager.getLegacyRtcVerdict(req.params.documentId, sessionDid)
          : undefined;
        res.status(200).json({
          ...ctx,
          sessionExists: !!session,
          ...(legacyRtc !== undefined ? { legacyRtc } : {}),
        });
        return;
      }
      res.status(200).json(ctx);
    } catch {
      res.status(500).json({ error: "share-context lookup failed" });
    }
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
