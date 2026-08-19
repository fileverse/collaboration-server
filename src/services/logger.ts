import { pino } from "pino";

// Single-line JSON to stdout; level via LOG_LEVEL (default info). `base: undefined`
// drops the pid/hostname fields that are meaningless on managed hosting.
// Pino throws on unknown level strings, so an env typo must not crash boot.
const LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];
const requested = process.env.LOG_LEVEL ?? "info";
const level = LEVELS.includes(requested) ? requested : "info";

export const logger = pino({
  level,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
});

export const perfLogger = logger.child({ mod: "perf" });
