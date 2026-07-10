import { describe, it, expect, vi } from "vitest";
import { reconcilePublishedDocuments } from "../../services/published-reconciler";

const makeStore = (refs: any[]) => ({
  listUnpublishedMetaRefs: vi.fn().mockResolvedValue(refs),
  markDocumentsPublished: vi.fn().mockResolvedValue(undefined),
});

describe("reconcilePublishedDocuments", () => {
  it("marks exactly the published subset and reports counts", async () => {
    const refs = [
      { documentId: "d1", portalAddress: "0xP" },
      { documentId: "d2", portalAddress: "0xP" },
      { documentId: "d3", portalAddress: "0xP" },
    ];
    const store = makeStore(refs);
    const resolve = vi.fn().mockResolvedValue(new Set(["d1", "d3"]));

    const out = await reconcilePublishedDocuments({
      mongodbStore: store as any,
      resolvePublishedDocumentIds: resolve,
      batchSize: 500,
    });

    expect(store.listUnpublishedMetaRefs).toHaveBeenCalledWith(500);
    expect(resolve).toHaveBeenCalledWith(refs);
    expect(store.markDocumentsPublished).toHaveBeenCalledWith(["d1", "d3"]);
    expect(out).toEqual({ scanned: 3, published: 2 });
  });

  it("no-ops when there are no candidates", async () => {
    const store = makeStore([]);
    const resolve = vi.fn();
    const out = await reconcilePublishedDocuments({
      mongodbStore: store as any,
      resolvePublishedDocumentIds: resolve,
      batchSize: 500,
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(store.markDocumentsPublished).not.toHaveBeenCalled();
    expect(out).toEqual({ scanned: 0, published: 0 });
  });

  it("does not call markDocumentsPublished when nothing resolved published", async () => {
    const store = makeStore([{ documentId: "d1", portalAddress: "0xP" }]);
    const resolve = vi.fn().mockResolvedValue(new Set<string>());
    const out = await reconcilePublishedDocuments({
      mongodbStore: store as any,
      resolvePublishedDocumentIds: resolve,
      batchSize: 500,
    });
    expect(store.markDocumentsPublished).not.toHaveBeenCalled();
    expect(out).toEqual({ scanned: 1, published: 0 });
  });
});
