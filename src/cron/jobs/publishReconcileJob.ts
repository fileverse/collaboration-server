import type { Job } from "agenda";
import { agenda } from "../agenda.js";
import { config } from "../../config/index.js";
import { mongodbStore } from "../../services/mongodb-store.js";
import { resolvePublishedDocumentIds } from "../../utils/contract.js";
import { reconcilePublishedDocuments } from "../../services/published-reconciler.js";
import { logger } from "../../services/logger";

const jobName = "PUBLISH_RECONCILE";

async function jobDefinition(job: Job, done: (err?: Error) => void) {
  try {
    const { scanned, published } = await reconcilePublishedDocuments({
      mongodbStore,
      resolvePublishedDocumentIds,
      batchSize: config.publishReconcile.batchSize,
    });
    logger.info(`[${jobName}] scanned=${scanned} published=${published}`);
    done();
  } catch (err: any) {
    logger.error(`[${jobName}] ${err?.message ?? err}`);
    done(err);
  }
}

async function setupJob() {
  agenda.define(jobName, jobDefinition);
  await agenda.every(config.publishReconcile.interval, jobName);
}

export default { setupJob };
