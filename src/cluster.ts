import cluster from "cluster";
import os from "os";

const numCPUs = os.cpus().length;
const maxWorkers = parseInt(process.env.WEB_CONCURRENCY || "1"); // Conservative default
const workers = Math.min(numCPUs, maxWorkers);

// Memory-aware worker calculation for Heroku
const dynoMemoryMB = parseInt(process.env.MEMORY_AVAILABLE || "512");
const workerMemoryMB = 200; // Estimated memory per worker
const maxMemoryWorkers = Math.floor((dynoMemoryMB - 100) / workerMemoryMB); // Reserve 100MB for master

const finalWorkers = Math.min(workers, maxMemoryWorkers);

console.log(`💾 Available memory: ${dynoMemoryMB}MB`);
console.log(
  `🔧 Calculated workers: ${finalWorkers} (requested: ${maxWorkers}, CPU cores: ${numCPUs})`
);

if (cluster.isPrimary) {
  console.log(`🚀 Master ${process.pid} is running`);
  console.log(`Starting ${finalWorkers} workers...`);

  // Fork workers with memory awareness
  for (let i = 0; i < finalWorkers; i++) {
    const worker = cluster.fork({
      WORKER_ID: i,
      TOTAL_WORKERS: finalWorkers,
    });
    console.log(`👷 Worker ${worker.process.pid} started (${i + 1}/${finalWorkers})`);
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
