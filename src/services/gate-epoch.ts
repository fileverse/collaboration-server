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

const EDIT_BOUND_TTL_MS = 10_000; // revocation-latency SLA; targeted evict() makes it near-instant

type BoundState = "bound" | "unbound" | "stale-bound" | "cold";

/**
 * Per-actor fail-closed cache of gate edit-binding (see docs/architecture/gp-semaphore.md).
 * Same expiry-on-read + single-flight shape as GateEpochCache, but keyed per (docId, handle)
 * and fail-closed on a cold/never-fetched entry instead of fail-open.
 */
export class EditBoundCache {
  private cache = new Map<string, { bound: boolean; fetchedAt: number }>();
  private inflight = new Map<string, Promise<boolean | null>>();

  constructor(private gateUrl: string | undefined = config.gate.url) {}

  private key(docId: string, editHandle: string): string {
    return `${docId} ${editHandle}`;
  }

  private async rawFetch(docId: string, editHandle: string): Promise<boolean | null> {
    if (!this.gateUrl) return null;
    try {
      const res = await fetch(`${this.gateUrl}/gate/doc/${docId}/edit-bound`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handles: [editHandle] }),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { bound?: string[] };
      const bound = Array.isArray(body.bound) && body.bound.includes(editHandle);
      this.cache.set(this.key(docId, editHandle), { bound, fetchedAt: Date.now() });
      return bound;
    } catch (error) {
      console.error("edit-bound fetch error:", error);
      return null;
    }
  }

  private fetch(docId: string, editHandle: string): Promise<boolean | null> {
    const k = this.key(docId, editHandle);
    const existing = this.inflight.get(k);
    if (existing) return existing; // single-flight: coalesce concurrent misses
    const p = this.rawFetch(docId, editHandle).finally(() => this.inflight.delete(k));
    this.inflight.set(k, p);
    return p;
  }

  /** Cached read (≤TTL, expiry-on-read); fetches on miss/expiry; fail-closed on gate error. */
  async check(docId: string, editHandle: string): Promise<BoundState> {
    const hit = this.cache.get(this.key(docId, editHandle));
    if (hit && Date.now() - hit.fetchedAt < EDIT_BOUND_TTL_MS) return hit.bound ? "bound" : "unbound";
    const fresh = await this.fetch(docId, editHandle);
    if (fresh !== null) return fresh ? "bound" : "unbound";
    // Gate unreachable: serve last-known-good BOUND past its TTL (permissions can't change
    // while the gate is down — a demote itself needs the gate). Never serve stale unbound,
    // never serve cold as admitted.
    if (hit?.bound) return "stale-bound";
    return "cold";
  }

  /** Targeted revocation: drop specific (docId, handle) entries so the next check() re-fetches. */
  evict(docId: string, handles: string[]): void {
    for (const editHandle of handles) this.cache.delete(this.key(docId, editHandle));
  }
}

export const editBoundCache = new EditBoundCache();
