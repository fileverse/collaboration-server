import Agenda from "agenda";
import { config } from "../config/index.js";

export const agenda = new Agenda({
  db: { address: config.database.uri },
  defaultConcurrency: config.agenda.concurrency,
  defaultLockLimit: config.agenda.concurrency,
});

agenda.on("start", (job) => console.log("Job %s starting", job.attrs.name));
agenda.on("complete", (job) => console.log(`Job ${job.attrs.name} finished`));
