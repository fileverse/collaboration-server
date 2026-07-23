import { describe, it, expect, vi, beforeEach } from "vitest";
import * as ucans from "@ucans/ucans";
import { AuthService } from "../../services/auth";
import { getIdentitySigningDid } from "../../utils/contract";

// Real round-trip: mint the same shape the client produces (facts, not an argument) and
// verify against a mocked chain read. See docs/architecture/edit-permission.md.
vi.mock("../../utils/contract", () => ({ getIdentitySigningDid: vi.fn() }));

async function mint(issuer: ucans.EdKeypair, serverDid: string, ddocId: string, facts: Record<string, unknown>[]) {
  const u = await ucans.build({
    issuer,
    audience: serverDid,
    capabilities: [
      {
        with: { scheme: "storage", hierPart: ddocId },
        can: { namespace: "collaboration", segments: ["OWN"] },
      },
    ],
    facts,
    lifetimeInSeconds: 3600,
  });
  return ucans.encode(u);
}

describe("verifyIdentityToken (UCAN fact round-trip)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("verifies and returns the on-chain signingDid when the fact + rootIssuer both check out", async () => {
    const issuer = await ucans.EdKeypair.create();
    const server = await ucans.EdKeypair.create();
    const svc = new AuthService(server.did());
    const token = await mint(issuer, server.did(), "ddoc-1", [{ identityContractAddress: "0xabc0000000000000000000000000000000abc0" }]);

    (getIdentitySigningDid as any).mockResolvedValue(issuer.did());

    expect(await svc.verifyIdentityToken(token, "ddoc-1")).toBe(issuer.did());
    expect(getIdentitySigningDid).toHaveBeenCalledWith("0xabc0000000000000000000000000000000abc0");
  });

  it("returns null when the token was minted without the identity fact", async () => {
    const issuer = await ucans.EdKeypair.create();
    const server = await ucans.EdKeypair.create();
    const svc = new AuthService(server.did());
    const token = await mint(issuer, server.did(), "ddoc-1", []);

    expect(await svc.verifyIdentityToken(token, "ddoc-1")).toBeNull();
    expect(getIdentitySigningDid).not.toHaveBeenCalled();
  });

  it("returns null when the fact's address is unregistered on-chain (getIdentitySigningDid → null)", async () => {
    const issuer = await ucans.EdKeypair.create();
    const server = await ucans.EdKeypair.create();
    const svc = new AuthService(server.did());
    const token = await mint(issuer, server.did(), "ddoc-1", [{ identityContractAddress: "0xabc0000000000000000000000000000000abc0" }]);

    (getIdentitySigningDid as any).mockResolvedValue(null);

    expect(await svc.verifyIdentityToken(token, "ddoc-1")).toBeNull();
  });

  it("returns null when the token's issuer does not root at the on-chain signingDid (wrong rootIssuer)", async () => {
    const issuer = await ucans.EdKeypair.create();
    const attacker = await ucans.EdKeypair.create();
    const server = await ucans.EdKeypair.create();
    const svc = new AuthService(server.did());
    const token = await mint(issuer, server.did(), "ddoc-1", [{ identityContractAddress: "0xabc0000000000000000000000000000000abc0" }]);

    // The chain says the address's signing key is the ATTACKER's DID, not the token's issuer.
    (getIdentitySigningDid as any).mockResolvedValue(attacker.did());

    expect(await svc.verifyIdentityToken(token, "ddoc-1")).toBeNull();
  });
});
