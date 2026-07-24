import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import type { AuthService } from "./auth";
import { SessionTerminatedError, type MongoDBStore } from "./mongodb-store";
import { resolveEditAdmission } from "./socket-handlers";

export const FLUSH_MAX_BYTES = 2 * 1024 * 1024; // a final delta is small; cap well under the 10MB body limit

export interface FlushDeps {
  authService: Pick<AuthService, "verifyCollaborationToken" | "verifyEditUcan">;
  mongodbStore: Pick<MongoDBStore, "createUpdate" | "getMinEditEpoch">;
}

export function createFlushHandler(deps: FlushDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const { documentId, sessionDid, collaborationToken, data, editUcan } = req.body || {};
    if (!documentId || !sessionDid || !collaborationToken || !data) {
      res.status(400).json({ error: "documentId, sessionDid, collaborationToken and data are required" });
      return;
    }
    if (typeof data !== "string" || data.length > FLUSH_MAX_BYTES) {
      res.status(413).json({ error: "Flush payload too large" });
      return;
    }

    const verified = await deps.authService.verifyCollaborationToken(collaborationToken, sessionDid, documentId);
    if (!verified) {
      res.status(401).json({ error: "Authentication failed" });
      return;
    }

    // H3(a) belt: when the beacon carries a gp-actor editUcan (the same value sent at JOIN), re-run
    // JOIN's offline admission here so a below-floor/revoked claim is refused on the durable-write
    // path too — covering the rotation-deferred and pre-cutover window. Honest-client defense in
    // depth; the hard gate stays rotation + session-termination. Rails without a claim (public/
    // workspace/owner) skip it, mirroring JOIN's `if (args.editUcan)` branch.
    if (typeof editUcan === "string" && editUcan) {
      const admission = await resolveEditAdmission(deps, editUcan, documentId);
      if (!admission.ok) {
        res.status(403).json({ error: "Edit access is not authorized for this document" });
        return;
      }
    }

    // Per-actor edit admission runs at socket JOIN; this durable-write path additionally
    // refuses a terminated (rotated-away) session so a lingering old-session client cannot
    // persist. Zero-knowledge — the server never reads `data`.
    try {
      await deps.mongodbStore.createUpdate({
        id: uuidv4(),
        documentId,
        data,
        updateType: "yjs_update",
        committed: false,
        commitCid: null,
        createdAt: Date.now(),
        sessionDid,
        appType: "ddoc",
      });
    } catch (err) {
      if (err instanceof SessionTerminatedError) {
        res.status(409).json({ error: "Session terminated" });
        return;
      }
      throw err;
    }
    res.status(200).json({ ok: true });
  };
}
