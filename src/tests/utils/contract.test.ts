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
