import { monitorEventLoopDelay } from "perf_hooks";
import type { AppServer } from "../types/index";
import { perfLogger } from "./logger";

type AckStats = {
  n: number;
  sumMs: number;
  maxMs: number;
  over1s: number;
  over5s: number;
  over15s: number;
};

const ackStats = new Map<string, AckStats>();

const SLOW_ACK_LOG_MS = 2_000;
const SUMMARY_INTERVAL_MS = 60_000;
// Timer-drift stall detection (same approach as the `blocked` / `toobusy-js`
// packages): a tick firing late proves the loop was blocked, with a timestamp —
// which the monitorEventLoopDelay histogram cannot provide.
const STALL_TICK_MS = 100;
const STALL_WARN_MS = 250;

let started = false;

/**
 * Wraps a socket ack callback to measure receipt→ack latency. over15s matters most:
 * the client's emit timeout is 15s, so any ack in that bucket arrived after the
 * client already surfaced a SocketTimeoutError.
 */
export function timeAck<T>(
  event: string,
  documentId: string | undefined,
  callback: ((response: T) => void) | undefined
): (response: T) => void {
  const startedAt = Date.now();
  return (response: T) => {
    const ms = Date.now() - startedAt;
    let s = ackStats.get(event);
    if (!s) {
      s = { n: 0, sumMs: 0, maxMs: 0, over1s: 0, over5s: 0, over15s: 0 };
      ackStats.set(event, s);
    }
    s.n++;
    s.sumMs += ms;
    if (ms > s.maxMs) s.maxMs = ms;
    if (ms > 1_000) s.over1s++;
    if (ms > 5_000) s.over5s++;
    if (ms > 15_000) s.over15s++;
    if (ms > SLOW_ACK_LOG_MS) {
      perfLogger.warn({ event, ms, doc: documentId ?? null }, "slow ack");
    }
    if (typeof callback === "function") callback(response);
  };
}

export function startPerfMonitor(io: AppServer): void {
  if (started) return;
  started = true;

  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();

  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    const stalledMs = now - last - STALL_TICK_MS;
    if (stalledMs > STALL_WARN_MS) perfLogger.warn({ stalledMs }, "event-loop stall");
    last = now;
  }, STALL_TICK_MS).unref();

  setInterval(() => {
    const loopMs = {
      p50: Math.round(loop.percentile(50) / 1e6),
      p99: Math.round(loop.percentile(99) / 1e6),
      max: Math.round(loop.max / 1e6),
    };
    loop.reset();

    const acks: Record<string, Omit<AckStats, "sumMs"> & { avgMs: number }> = {};
    for (const [event, s] of ackStats) {
      acks[event] = {
        n: s.n,
        avgMs: Math.round(s.sumMs / s.n),
        maxMs: s.maxMs,
        over1s: s.over1s,
        over5s: s.over5s,
        over15s: s.over15s,
      };
    }
    ackStats.clear();

    perfLogger.info(
      { sockets: io.engine.clientsCount, loopMs, acks },
      "perf summary"
    );
  }, SUMMARY_INTERVAL_MS).unref();
}
