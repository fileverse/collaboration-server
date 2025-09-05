import cluster from "cluster";
import os from "os";

const numCPUs = os.cpus().length;
const maxWorkers = parseInt(process.env.WEB_CONCURRENCY || "2"); // Heroku sets this
const workers = Math.min(numCPUs, maxWorkers);

if (cluster.isPrimary) {
  console.log(`Master ${process.pid} is running`);
  console.log(`Starting ${workers} workers...`);

  // Fork workers
  for (let i = 0; i < workers; i++) {
    const worker = cluster.fork();
    console.log(`Worker ${worker.process.pid} started`);
  }

  // Handle worker exit
  cluster.on("exit", (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died with code ${code} and signal ${signal}`);
    console.log("Starting a new worker...");
    cluster.fork();
  });

  // Graceful shutdown
  process.on("SIGTERM", () => {
    console.log("Master received SIGTERM, shutting down workers...");
    for (const id in cluster.workers) {
      cluster.workers[id]?.kill();
    }
  });
} else {
  // Worker process - start the actual server
  import("./index.js")
    .then(() => {
      console.log(`Worker ${process.pid} started`);
    })
    .catch((error) => {
      console.error(`Worker ${process.pid} failed to start:`, error);
      process.exit(1);
    });
}
