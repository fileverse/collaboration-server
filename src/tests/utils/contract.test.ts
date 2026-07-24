import { describe, it, expect, vi, beforeEach } from "vitest";
import * as contract from "../../utils/contract";

describe("getIdentitySigningDid", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("reads signingDid from getIdentityModulePublicDetails at the given address", async () => {
    const spy = vi.spyOn(contract.publicClient, "readContract").mockResolvedValue({
      salt: 1n,
      signingDid: "did:key:zOwner",
      accountPublicKey: "0x",
      agentAddress: "0xabc",
    } as any);

    const did = await contract.getIdentitySigningDid("0x000000000000000000000000000000000000dEaD");

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        address: "0x000000000000000000000000000000000000dEaD",
        functionName: "getIdentityModulePublicDetails",
      })
    );
    expect(did).toBe("did:key:zOwner");
  });

  it("returns null on a read failure", async () => {
    vi.spyOn(contract.publicClient, "readContract").mockRejectedValue(new Error("revert"));
    const did = await contract.getIdentitySigningDid("0x000000000000000000000000000000000000bEEf");
    expect(did).toBeNull();
  });
});

describe("bustOwnerDidCacheForPortal", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("drops all collaborator entries for the portal regardless of casing, leaves other portals", async () => {
    const spy = vi
      .spyOn(contract.publicClient, "readContract")
      .mockResolvedValue(["0xAgent", "did:key:zCollab"] as any);

    const portalMixedCase = "0xAaAa000000000000000000000000000000aAaA";
    const portalOppositeCase = "0xaAAA000000000000000000000000000000AaAa";
    const otherPortal = "0xBbBb000000000000000000000000000000bBbB";
    const collaboratorA = "0x1111000000000000000000000000000000cccc";
    const collaboratorB = "0x2222000000000000000000000000000000dddd";

    await contract.getOwnerDid(portalMixedCase as any, collaboratorA as any);
    await contract.getOwnerDid(otherPortal as any, collaboratorB as any);
    expect(spy).toHaveBeenCalledTimes(2);

    contract.bustOwnerDidCacheForPortal(portalOppositeCase);

    // Busted portal: cache entry gone, so a fresh chain read happens.
    await contract.getOwnerDid(portalMixedCase as any, collaboratorA as any);
    expect(spy).toHaveBeenCalledTimes(3);

    // Other portal: cache entry untouched, no additional chain read.
    await contract.getOwnerDid(otherPortal as any, collaboratorB as any);
    expect(spy).toHaveBeenCalledTimes(3);
  });
});

describe("getPortalOwnerAddress", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("reads owner() once and caches it", async () => {
    const spy = vi
      .spyOn(contract.publicClient, "readContract")
      .mockResolvedValue("0xOwnerAddress0000000000000000000000000000");

    const first = await contract.getPortalOwnerAddress("0xPortalOwnerAddr000000000000000000000000" as any);
    const second = await contract.getPortalOwnerAddress("0xPortalOwnerAddr000000000000000000000000" as any);

    expect(first).toBe("0xOwnerAddress0000000000000000000000000000");
    expect(second).toBe("0xOwnerAddress0000000000000000000000000000");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "owner" })
    );
  });
});

describe("getOwnerDid negative caching", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("caches a confirmed non-collaborator (empty result) so repeat lookups skip the RPC", async () => {
    const spy = vi.spyOn(contract.publicClient, "readContract").mockResolvedValue("" as any);
    const portal = "0x9a11000000000000000000000000000000000001" as any;
    const addr = "0x9a11000000000000000000000000000000000002" as any;

    const first = await contract.getOwnerDid(portal, addr);
    const second = await contract.getOwnerDid(portal, addr);

    expect(first).toBe("");
    expect(second).toBe("");
    // One miss reads the chain (legacy + v2 = 2 reads); the cached "" serves the rest.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does NOT cache an RPC failure — the next lookup retries the chain", async () => {
    const spy = vi
      .spyOn(contract.publicClient, "readContract")
      .mockRejectedValue(new Error("rate limited"));
    const portal = "0x9b22000000000000000000000000000000000003" as any;
    const addr = "0x9b22000000000000000000000000000000000004" as any;

    const first = await contract.getOwnerDid(portal, addr);
    const second = await contract.getOwnerDid(portal, addr);

    expect(first).toBeNull();
    expect(second).toBeNull();
    // A caught read returns null (indistinguishable from a transient blip), so it
    // must never be cached — both misses re-read the chain (2 reads each).
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("refreshOwnerDid also does NOT persist a null — the recheck path must not lock the owner out", async () => {
    const spy = vi
      .spyOn(contract.publicClient, "readContract")
      .mockRejectedValue(new Error("rate limited"));
    const portal = "0x9c33000000000000000000000000000000000005" as any;
    const addr = "0x9c33000000000000000000000000000000000006" as any;

    const refreshed = await contract.refreshOwnerDid(portal, addr);
    expect(refreshed).toBeNull();
    // The null was not cached, so a follow-up getOwnerDid re-reads the chain
    // (recovers as soon as the RPC heals) instead of serving a stale null.
    await contract.getOwnerDid(portal, addr);
    expect(spy).toHaveBeenCalledTimes(4);
  });
});
