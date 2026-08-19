import { agenda } from "./agenda.js";
import { databaseService } from "../database/index.js";
import gracePurgeJob from "./jobs/gracePurgeJob.js";
import { logger } from "../services/logger";

async function graceful() {
  await agenda.stop();
  await databaseService.disconnect();
  process.exit(0);
}

(async () => {
  try {
    // The job queries mongoose models, so this worker needs its own DB connection
    // (Agenda's Mongo connection only backs the jobs collection).
    await databaseService.connect();
    await agenda.start();
    await gracePurgeJob.setupJob();
    logger.info("grace-purge worker started");
  } catch (err) {
    logger.error(err);
    await graceful();
  }
})();

process.on("SIGTERM", graceful);
process.on("SIGINT", graceful);
