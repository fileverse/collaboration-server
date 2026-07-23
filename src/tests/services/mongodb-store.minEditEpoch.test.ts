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
});
