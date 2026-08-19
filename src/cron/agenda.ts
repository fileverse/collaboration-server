import Agenda from "agenda";
import { config } from "../config/index.js";
import { logger } from "../services/logger";

export const agenda = new Agenda({
  db: { address: config.database.uri },
  defaultConcurrency: config.agenda.concurrency,
  defaultLockLimit: config.agenda.concurrency,
});

agenda.on("start", (job) => logger.info("Job %s starting", job.attrs.name));
agenda.on("complete", (job) => logger.info(`Job ${job.attrs.name} finished`));
