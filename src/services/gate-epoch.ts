import { config } from "../config";

const TTL_MS = 30_000;

/**
 * Passive single-flight cache of the gate's per-doc editGrantEpoch. No timer: entries
 * expire on read (fetchedAt + TTL) and concurrent misses coalesce into one fetch.
 */
export class GateEpochCache {
  private cache = new Map<string, { epoch: number; fetchedAt: number }>();
  private inflight = new Map<string, Promise<number | null>>();

  constructor(private gateUrl: string | undefined = config.gate.url) {}

  private async rawFetch(documentId: string): Promise<number | null> {
    if (!this.gateUrl) return null;
    try {
      const res = await fetch(`${this.gateUrl}/gate/doc/${documentId}/edit-grant-epoch`);
      if (!res.ok) return null;
      const body = (await res.json()) as { editGrantEpoch?: number };
      if (typeof body.editGrantEpoch !== "number") return null;
      // editGrantEpoch only ever increases; a slow read that started before a bump must
      // not overwrite a fresher cached value with its stale epoch.
      const existing = this.cache.get(documentId);
      if (!existing || body.editGrantEpoch >= existing.epoch) {
        this.cache.set(documentId, { epoch: body.editGrantEpoch, fetchedAt: Date.now() });
      }
      return body.editGrantEpoch;
    } catch (error) {
      console.error("Gate epoch fetch error:", error);
      return null;
    }
  }

  private fetchEpoch(documentId: string): Promise<number | null> {
    if (!this.gateUrl) return Promise.resolve(null);
    const existing = this.inflight.get(documentId);
    if (existing) return existing; // single-flight: coalesce concurrent misses
    const p = this.rawFetch(documentId).finally(() => this.inflight.delete(documentId));
    this.inflight.set(documentId, p);
    return p;
  }

  /** Cached read (≤TTL, expiry-on-read); zero network on a fresh hit. */
  async getEditGrantEpoch(documentId: string): Promise<number | null> {
    const hit = this.cache.get(documentId);
    if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.epoch;
    return this.fetchEpoch(documentId);
  }

  /** Force-drop path: must observe the post-bump epoch, so fetch directly and bypass the
   *  single-flight coalescing that could hand back a pre-bump in-flight read. */
  async refreshEditGrantEpoch(documentId: string): Promise<number | null> {
    return this.rawFetch(documentId);
  }
}

export const gateEpochCache = new GateEpochCache();
