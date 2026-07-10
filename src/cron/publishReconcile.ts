import { agenda } from "./agenda.js";
import { databaseService } from "../database/index.js";
import publishReconcileJob from "./jobs/publishReconcileJob.js";

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
    await publishReconcileJob.setupJob();
    console.log("publish-reconcile worker started");
  } catch (err) {
    console.error(err);
    await graceful();
  }
})();

process.on("SIGTERM", graceful);
process.on("SIGINT", graceful);
