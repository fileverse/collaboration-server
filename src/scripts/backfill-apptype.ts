/**
 * One-time backfill: tag every pre-`appType` row as "ddoc".
 *
 * The collaboration server is shared between ddoc and dsheet. dsheet is the first
 * app to write the `appType` field, so every row that predates it belongs to ddoc.
 * Running this makes every row explicit, so per-app queries are plain equality
 * with no null-handling.
 *
 * Idempotent — only touches rows where `appType` is missing. Safe to re-run.
 *
 * Usage:  tsx src/scripts/backfill-apptype.ts
 */
import "dotenv/config";
import { databaseService } from "../database";
import {
  DocumentUpdateModel,
  DocumentCommitModel,
  SessionModel,
  DocumentMetaModel,
} from "../database/models";
import { logger } from "../services/logger";

async function backfill(): Promise<void> {
  await databaseService.connect();

  const filter = { appType: { $exists: false } };
  const set = { $set: { appType: "ddoc" as const } };

  const [updates, commits, sessions, metas] = await Promise.all([
    DocumentUpdateModel.updateMany(filter, set),
    DocumentCommitModel.updateMany(filter, set),
    SessionModel.updateMany(filter, set),
    DocumentMetaModel.updateMany(filter, set),
  ]);

  logger.info("appType backfill complete:");
  logger.info(`  DocumentUpdate: ${updates.modifiedCount} tagged "ddoc"`);
  logger.info(`  DocumentCommit: ${commits.modifiedCount} tagged "ddoc"`);
  logger.info(`  Session:        ${sessions.modifiedCount} tagged "ddoc"`);
  logger.info(`  DocumentMeta:   ${metas.modifiedCount} tagged "ddoc"`);

  await databaseService.disconnect();
}

backfill()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "appType backfill failed");
    process.exit(1);
  });
