import type { Request, Response } from "express";
import type { MongoDBStore } from "./mongodb-store";
import { DocumentMetaModel } from "../database/models";
import { config } from "../config";

export interface DeletedFileWebhookDeps {
  mongodbStore: Pick<MongoDBStore, "tombstoneDocument">;
  onTombstoned?: (documentId: string) => Promise<void>; // drop live sessions
}

// Reversible tombstone from the on-chain DeletedFile event — see
// docs/architecture/edit-permission.md. Portal-matches the webhook payload against
// the immutable pin (DocumentMeta.portalAddress) so a colliding appFileId minted
// under an attacker-controlled portal cannot tombstone another owner's document.
export function createDeletedFileWebhookHandler(deps: DeletedFileWebhookDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const secret = req.header("x-webhook-api-key");
    if (!config.webhook.apiKey || secret !== config.webhook.apiKey) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const { appFileId, portalAddress } = req.body || {};
    if (typeof appFileId !== "string" || typeof portalAddress !== "string") {
      res.status(400).json({ error: "appFileId and portalAddress are required" });
      return;
    }
    const meta = await DocumentMetaModel.findById(appFileId).select("portalAddress").lean();
    if (!meta || (meta.portalAddress ?? "").toLowerCase() !== portalAddress.toLowerCase()) {
      res.status(200).json({ ok: true, matched: false }); // idempotent no-op
      return;
    }
    const done = await deps.mongodbStore.tombstoneDocument(appFileId, "onchain-delete");
    if (done && deps.onTombstoned) await deps.onTombstoned(appFileId);
    res.status(200).json({ ok: true, matched: true });
  };
}
