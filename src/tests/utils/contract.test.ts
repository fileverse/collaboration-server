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
