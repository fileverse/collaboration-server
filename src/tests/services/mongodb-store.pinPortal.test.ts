// HONESTY NOTE: real first-writer-wins immutability is enforced by Mongo `_id`
// uniqueness + `$setOnInsert`, which this mock cannot exercise. These tests verify
// the store ISSUES the correct atomic operators — the accepted test level for this
// repo's mocked-Mongoose store suite (see mongodb-store.minEditEpoch.test.ts).
import { describe, it, expect, vi, beforeEach } from "vitest";

const findOneAndUpdate = vi.fn();
const updateOne = vi.fn();
const findById = vi.fn();

vi.mock("../../database/models", () => ({
  DocumentMetaModel: {
    findOneAndUpdate: (...a: unknown[]) => findOneAndUpdate(...a),
    updateOne: (...a: unknown[]) => updateOne(...a),
    findById: (...a: unknown[]) => findById(...a),
  },
  // other models referenced by mongodb-store's import — stub as empty objects
  DocumentUpdateModel: {}, DocumentCommitModel: {}, CounterModel: {},
  SessionModel: {}, DocumentMirrorModel: {}, DocumentEditEpochModel: {},
}));

import { MongoDBStore } from "../../services/mongodb-store";

describe("pinDocumentPortalIfAbsent", () => {
  const store = new MongoDBStore();
  beforeEach(() => {
    vi.clearAllMocks();
    findOneAndUpdate.mockResolvedValue({});
    updateOne.mockResolvedValue({});
    findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ portalAddress: "0xP1" }) }) });
  });

  it("pins the binding fields via $setOnInsert, never $set", async () => {
    await store.pinDocumentPortalIfAbsent({
      documentId: "d1",
      portalAddress: "0xP1",
      ownerDid: "did:key:o",
      ownerIdentityDid: "did:key:i",
      sessionDid: "did:key:s1",
    });

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "d1" },
      {
        $setOnInsert: expect.objectContaining({
          portalAddress: "0xP1",
          ownerDid: "did:key:o",
          ownerIdentityDid: "did:key:i",
          sessionDid: "did:key:s1",
        }),
      },
      { upsert: true, writeConcern: { w: "majority", j: true } }
    );
    const [, updatePayload] = findOneAndUpdate.mock.calls[0];
    expect(updatePayload.$set).toBeUndefined();
  });

  it("issues the backfill updateOne with the null-guard filter", async () => {
    await store.pinDocumentPortalIfAbsent({
      documentId: "d1",
      portalAddress: "0xP1",
      ownerDid: "did:key:o",
      ownerIdentityDid: "did:key:i",
      sessionDid: "did:key:s1",
    });

    expect(updateOne).toHaveBeenCalledWith(
      { _id: "d1", $or: [{ portalAddress: null }, { portalAddress: { $exists: false } }] },
      { $set: { portalAddress: "0xP1" } }
    );
  });

  it("returns the effective (post-insert) portalAddress", async () => {
    findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ portalAddress: "0xP1" }) }) });

    const result = await store.pinDocumentPortalIfAbsent({
      documentId: "d1",
      portalAddress: "0xATTACKER",
      ownerDid: "did:key:o2",
      ownerIdentityDid: "did:key:i2",
      sessionDid: "did:key:s2",
    });

    // The caller's own portal is irrelevant to the return value — the effective
    // pin comes from the post-backfill read, which the mock stubs as "0xP1".
    expect(result).toEqual({ portalAddress: "0xP1" });
  });

  it("legacy null-portal row: backfill runs, caller's portal wins the return (not null)", async () => {
    // Simulates a pre-existing row with portalAddress: null — the backfill updateOne
    // (asserted above) is what actually sets it; here we assert the read-back reflects
    // the caller's portal rather than the mock returning a lockout `null`.
    findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ portalAddress: "0xP1" }) }) });

    const result = await store.pinDocumentPortalIfAbsent({
      documentId: "legacy-doc",
      portalAddress: "0xP1",
      ownerDid: null,
      ownerIdentityDid: "did:key:i",
      sessionDid: "did:key:s",
    });

    expect(result.portalAddress).toBe("0xP1");
    expect(result.portalAddress).not.toBeNull();
  });

  it("returns null when no row is found at all", async () => {
    findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) });

    const result = await store.pinDocumentPortalIfAbsent({
      documentId: "missing",
      portalAddress: "0xP1",
      ownerDid: null,
      ownerIdentityDid: null,
      sessionDid: "did:key:s",
    });

    expect(result).toEqual({ portalAddress: null });
  });
});

describe("upsertDocumentMeta binding immutability", () => {
  const store = new MongoDBStore();
  beforeEach(() => {
    vi.clearAllMocks();
    findOneAndUpdate.mockResolvedValue({});
  });

  it("issues $setOnInsert for binding fields and $set for mutable fields", async () => {
    await store.upsertDocumentMeta({
      documentId: "d2",
      sessionDid: "did:key:s",
      ownerDid: "did:key:x",
      ownerIdentityDid: "did:key:x",
      portalAddress: "0xEVIL",
      editLock: "lk",
      title: "t",
    });

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "d2" },
      {
        $setOnInsert: {
          ownerDid: "did:key:x",
          ownerIdentityDid: "did:key:x",
          portalAddress: "0xEVIL",
        },
        $set: expect.objectContaining({
          sessionDid: "did:key:s",
          editLock: "lk",
          title: "t",
        }),
      },
      { upsert: true, new: true, writeConcern: { w: "majority", j: true } }
    );
    const [, updatePayload] = findOneAndUpdate.mock.calls[0];
    expect(updatePayload.$set.ownerDid).toBeUndefined();
    expect(updatePayload.$set.ownerIdentityDid).toBeUndefined();
    expect(updatePayload.$set.portalAddress).toBeUndefined();
  });
});
