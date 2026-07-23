import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const purgeTombstonedBefore = vi.fn();

vi.mock("../../cron/agenda", () => ({
  agenda: { define: vi.fn(), every: vi.fn() },
}));

vi.mock("../../config", () => ({
  config: { deleteGrace: { windowMs: 2592000000, interval: "1 hour", batchSize: 200 } },
}));

vi.mock("../../services/mongodb-store", () => ({
  mongodbStore: { purgeTombstonedBefore: (...args: unknown[]) => purgeTombstonedBefore(...args) },
}));

import { jobDefinition } from "../../cron/jobs/gracePurgeJob";
import { config } from "../../config";

describe("gracePurgeJob jobDefinition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("purges docs tombstoned before the grace-window cutoff and signals completion", async () => {
    purgeTombstonedBefore.mockResolvedValue(["d1", "d2"]);
    const done = vi.fn();

    await jobDefinition({} as any, done);

    expect(purgeTombstonedBefore).toHaveBeenCalledTimes(1);
    expect(purgeTombstonedBefore).toHaveBeenCalledWith(
      Date.now() - config.deleteGrace.windowMs,
      config.deleteGrace.batchSize
    );
    expect(done).toHaveBeenCalledTimes(1);
    expect(done.mock.calls[0][0]).toBeUndefined();
  });

  it("forwards the store error to done on failure", async () => {
    const err = new Error("mongo down");
    purgeTombstonedBefore.mockRejectedValue(err);
    const done = vi.fn();

    await jobDefinition({} as any, done);

    expect(done).toHaveBeenCalledWith(err);
  });
});
