import type { Job } from "agenda";
import { agenda } from "../agenda.js";
import { config } from "../../config/index.js";
import { mongodbStore } from "../../services/mongodb-store.js";

const jobName = "DELETE_GRACE_PURGE";

export async function jobDefinition(job: Job, done: (err?: Error) => void) {
  try {
    const cutoff = Date.now() - config.deleteGrace.windowMs;
    const purged = await mongodbStore.purgeTombstonedBefore(cutoff, config.deleteGrace.batchSize);
    console.log(`[${jobName}] purged=${purged.length}`);
    done();
  } catch (err: any) {
    console.error(`[${jobName}] ${err?.message ?? err}`);
    done(err);
  }
}

async function setupJob() {
  agenda.define(jobName, jobDefinition);
  await agenda.every(config.deleteGrace.interval, jobName);
}

export default { setupJob };
