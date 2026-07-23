// HONESTY NOTE: real once-only tombstone semantics come from the Mongo filter
// `{ tombstonedAt: null }` on `updateOne`, which this mock cannot exercise. These
// tests verify the store ISSUES the correct queries/operators — the accepted test
// level for this repo's mocked-Mongoose store suite (see mongodb-store.minEditEpoch.test.ts).
import { describe, it, expect, vi, beforeEach } from "vitest";

const updateOne = vi.fn();
const findById = vi.fn();
const find = vi.fn();

vi.mock("../../database/models", () => ({
  DocumentMetaModel: {
    updateOne: (...a: unknown[]) => updateOne(...a),
    findById: (...a: unknown[]) => findById(...a),
    find: (...a: unknown[]) => find(...a),
  },
  // other models referenced by mongodb-store's import — stub as empty objects
  DocumentUpdateModel: {}, DocumentCommitModel: {}, CounterModel: {},
  SessionModel: {}, DocumentMirrorModel: {}, DocumentEditEpochModel: {},
}));

import { MongoDBStore } from "../../services/mongodb-store";

describe("tombstoneDocument", () => {
  const store = new MongoDBStore();
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets tombstonedAt/tombstoneReason on a live doc and returns true", async () => {
    updateOne.mockResolvedValue({ matchedCount: 1 });

    const result = await store.tombstoneDocument("d1", "on-chain-delete");

    expect(updateOne).toHaveBeenCalledWith(
      { _id: "d1", tombstonedAt: null },
      { $set: { tombstonedAt: expect.any(Number), tombstoneReason: "on-chain-delete" } }
    );
    expect(result).toBe(true);
  });

  it("is idempotent: already-tombstoned doc still returns true", async () => {
    updateOne.mockResolvedValue({ matchedCount: 0 });
    findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ tombstonedAt: 123 }) }) });

    const result = await store.tombstoneDocument("d1", "on-chain-delete");

    expect(result).toBe(true);
  });

  it("returns false when no row matches and the doc doesn't exist", async () => {
    updateOne.mockResolvedValue({ matchedCount: 0 });
    findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) });

    const result = await store.tombstoneDocument("missing", "on-chain-delete");

    expect(result).toBe(false);
  });
});

describe("isTombstoned", () => {
  const store = new MongoDBStore();
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when tombstonedAt is set", async () => {
    findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ tombstonedAt: 123 }) }) });
    expect(await store.isTombstoned("d1")).toBe(true);
  });

  it("returns false when tombstonedAt is null/absent", async () => {
    findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) });
    expect(await store.isTombstoned("d1")).toBe(false);
  });
});

describe("purgeTombstonedBefore", () => {
  const store = new MongoDBStore();
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("purges only rows past the cutoff via purgeDocument, and returns their ids", async () => {
    find.mockReturnValue({
      select: () => ({ limit: () => ({ lean: () => Promise.resolve([{ _id: "d1" }, { _id: "d2" }]) }) }),
    });
    const purgeDocument = vi.spyOn(store, "purgeDocument").mockResolvedValue(undefined);

    const cutoffMs = 1000;
    const result = await store.purgeTombstonedBefore(cutoffMs, 50);

    expect(find).toHaveBeenCalledWith({ tombstonedAt: { $ne: null, $lte: cutoffMs } });
    expect(purgeDocument).toHaveBeenCalledWith("d1");
    expect(purgeDocument).toHaveBeenCalledWith("d2");
    expect(purgeDocument).toHaveBeenCalledTimes(2);
    expect(result).toEqual(["d1", "d2"]);
  });

  it("returns an empty array when nothing is past the cutoff", async () => {
    find.mockReturnValue({ select: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) });
    const purgeDocument = vi.spyOn(store, "purgeDocument").mockResolvedValue(undefined);

    const result = await store.purgeTombstonedBefore(1000, 50);

    expect(purgeDocument).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});
