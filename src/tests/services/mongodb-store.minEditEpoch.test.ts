import { describe, it, expect, vi, beforeEach } from "vitest";

const findOneAndUpdate = vi.fn();
const findById = vi.fn();

vi.mock("../../database/models", () => ({
  DocumentEditEpochModel: {
    findOneAndUpdate: (...a: unknown[]) => findOneAndUpdate(...a),
    findById: (...a: unknown[]) => findById(...a),
  },
  // other models referenced by mongodb-store's import — stub as empty objects
  DocumentUpdateModel: {}, DocumentCommitModel: {}, CounterModel: {},
  SessionModel: {}, DocumentMetaModel: {}, DocumentMirrorModel: {},
}));

import { MongoDBStore } from "../../services/mongodb-store";

describe("minEditEpoch store", () => {
  const store = new MongoDBStore();
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("setMinEditEpoch upserts with a monotonic $max", async () => {
    findOneAndUpdate.mockResolvedValue({});
    await store.setMinEditEpoch("doc-1", 5);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "doc-1" },
      { $max: { minEditEpoch: 5 } },
      { upsert: true }
    );
  });

  it("getMinEditEpoch returns the stored value", async () => {
    findById.mockReturnValue({ lean: () => Promise.resolve({ minEditEpoch: 7 }) });
    expect(await store.getMinEditEpoch("doc-1")).toBe(7);
  });

  it("getMinEditEpoch returns 0 when the doc has no floor yet", async () => {
    findById.mockReturnValue({ lean: () => Promise.resolve(null) });
    expect(await store.getMinEditEpoch("doc-x")).toBe(0);
  });

  it("setEvictedHandles $max-stamps each handle under a dotted subpath (poseidon decimal keys are field-safe)", async () => {
    findOneAndUpdate.mockResolvedValue({});
    await store.setEvictedHandles("doc-1", ["123", "456"], 4);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "doc-1" },
      { $max: { "evictedHandles.123": 4, "evictedHandles.456": 4 } },
      { upsert: true }
    );
  });

  it("setEvictedHandles no-ops for an empty handle list", async () => {
    await store.setEvictedHandles("doc-1", [], 4);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("getEvictedHandleEpoch returns the handle's evict epoch", async () => {
    findById.mockReturnValue({ lean: () => Promise.resolve({ evictedHandles: { "123": 6 } }) });
    expect(await store.getEvictedHandleEpoch("doc-1", "123")).toBe(6);
  });

  it("getEvictedHandleEpoch returns undefined for a never-evicted handle", async () => {
    findById.mockReturnValue({ lean: () => Promise.resolve({ evictedHandles: { "123": 6 } }) });
    expect(await store.getEvictedHandleEpoch("doc-1", "999")).toBeUndefined();
  });

  it("getEvictedHandleEpoch returns undefined when the doc has no denylist", async () => {
    findById.mockReturnValue({ lean: () => Promise.resolve(null) });
    expect(await store.getEvictedHandleEpoch("doc-x", "123")).toBeUndefined();
  });
});
