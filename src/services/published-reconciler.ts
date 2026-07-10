import type { MongoDBStore } from "./mongodb-store";

// Flips DocumentMeta.isPublished for the unpublished candidate docs that are now
// on-chain. Best-effort: the caller (Agenda job) wraps this and retries next pass.
export const reconcilePublishedDocuments = async (deps: {
  mongodbStore: Pick<MongoDBStore, "listUnpublishedMetaRefs" | "markDocumentsPublished">;
  resolvePublishedDocumentIds: (
    refs: Array<{ documentId: string; portalAddress: string }>
  ) => Promise<Set<string>>;
  batchSize: number;
}): Promise<{ scanned: number; published: number }> => {
  const { mongodbStore, resolvePublishedDocumentIds, batchSize } = deps;

  const refs = await mongodbStore.listUnpublishedMetaRefs(batchSize);
  if (refs.length === 0) return { scanned: 0, published: 0 };

  const published = await resolvePublishedDocumentIds(refs);
  const ids = [...published];
  if (ids.length > 0) await mongodbStore.markDocumentsPublished(ids);

  return { scanned: refs.length, published: ids.length };
};
