import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import type { AuthService } from "./auth";
import type { MongoDBStore } from "./mongodb-store";

export const FLUSH_MAX_BYTES = 2 * 1024 * 1024; // a final delta is small; cap well under the 10MB body limit

export interface FlushDeps {
  authService: Pick<AuthService, "verifyCollaborationToken">;
  mongodbStore: Pick<MongoDBStore, "createUpdate">;
}

export function createFlushHandler(deps: FlushDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const { documentId, sessionDid, collaborationToken, data } = req.body || {};
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

    // Same chokepoint as the socket path: createUpdate applies seq + the durable-write gate; a row is
    // persisted only for a bound, non-terminated room. Zero-knowledge — the server never reads `data`.
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

    res.status(200).json({ ok: true });
  };
}
