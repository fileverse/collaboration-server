import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GateEpochCache } from "../../services/gate-epoch";

describe("GateEpochCache", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches, returns, and caches the editGrantEpoch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ editGrantEpoch: 7 }) });
    vi.stubGlobal("fetch", fetchMock);
    const cache = new GateEpochCache("https://gate.test");

    expect(await cache.getEditGrantEpoch("doc-1")).toBe(7);
    expect(await cache.getEditGrantEpoch("doc-1")).toBe(7); // cache hit — no second fetch
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://gate.test/gate/doc/doc-1/edit-grant-epoch");
  });

  it("refreshEditGrantEpoch bypasses the cache", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ editGrantEpoch: 1 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ editGrantEpoch: 2 }) });
    vi.stubGlobal("fetch", fetchMock);
    const cache = new GateEpochCache("https://gate.test");

    expect(await cache.getEditGrantEpoch("doc-1")).toBe(1);
    expect(await cache.refreshEditGrantEpoch("doc-1")).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns null on a non-ok response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    expect(await new GateEpochCache("https://gate.test").getEditGrantEpoch("doc-x")).toBeNull();
  });

  it("returns null WITHOUT calling fetch when no gate URL is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await new GateEpochCache(undefined).getEditGrantEpoch("doc-x")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when the response body has a non-number editGrantEpoch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ editGrantEpoch: "7" }) });
    vi.stubGlobal("fetch", fetchMock);
    expect(await new GateEpochCache("https://gate.test").getEditGrantEpoch("doc-x")).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await new GateEpochCache("https://gate.test").getEditGrantEpoch("doc-x")).toBeNull();
  });

  it("coalesces concurrent misses for the same doc into ONE fetch (single-flight)", async () => {
    let resolveFetch!: (v: unknown) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise((r) => (resolveFetch = r)));
    vi.stubGlobal("fetch", fetchMock);
    const cache = new GateEpochCache("https://gate.test");

    const p1 = cache.getEditGrantEpoch("doc-1");
    const p2 = cache.getEditGrantEpoch("doc-1"); // second miss before the first resolves
    resolveFetch({ ok: true, json: async () => ({ editGrantEpoch: 9 }) });

    expect(await p1).toBe(9);
    expect(await p2).toBe(9);
    expect(fetchMock).toHaveBeenCalledTimes(1); // both awaited the same in-flight fetch
  });

  it("refreshEditGrantEpoch does NOT piggyback on an in-flight cache read (observes the post-bump epoch)", async () => {
    let resolveFirst!: (v: unknown) => void;
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(new Promise((r) => (resolveFirst = r))) // in-flight get, pre-bump
      .mockResolvedValueOnce({ ok: true, json: async () => ({ editGrantEpoch: 2 }) }); // refresh's own fetch, post-bump
    vi.stubGlobal("fetch", fetchMock);
    const cache = new GateEpochCache("https://gate.test");

    const getP = cache.getEditGrantEpoch("doc-1"); // starts in-flight fetch #1
    const refreshP = cache.refreshEditGrantEpoch("doc-1"); // must NOT coalesce
    resolveFirst({ ok: true, json: async () => ({ editGrantEpoch: 1 }) });

    expect(await refreshP).toBe(2); // saw the post-bump epoch, not the stale in-flight 1
    expect(await getP).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2); // two independent fetches, no coalescing
  });

  it("a stale in-flight read does not clobber a fresher cached epoch (monotonic cache)", async () => {
    let resolveStale!: (v: unknown) => void;
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(new Promise((r) => (resolveStale = r))) // get → resolves to stale 1
      .mockResolvedValueOnce({ ok: true, json: async () => ({ editGrantEpoch: 2 }) }); // refresh → fresh 2
    vi.stubGlobal("fetch", fetchMock);
    const cache = new GateEpochCache("https://gate.test");

    const getP = cache.getEditGrantEpoch("doc-1"); // in-flight, will resolve to 1
    await cache.refreshEditGrantEpoch("doc-1"); // fetches 2, caches 2
    resolveStale({ ok: true, json: async () => ({ editGrantEpoch: 1 }) });
    await getP; // stale 1 resolves; monotonic guard must NOT overwrite cached 2

    expect(await cache.getEditGrantEpoch("doc-1")).toBe(2); // served from cache, still 2
    expect(fetchMock).toHaveBeenCalledTimes(2); // the cache-hit read did not re-fetch
  });
});
