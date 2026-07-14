import { describe, it, expect, vi, beforeEach } from "vitest";
import * as ucans from "@ucans/ucans";
import { AuthService } from "../../services/auth";
import { getIdentitySigningDid, getOwnerDid } from "../../utils/contract";

vi.mock("@ucans/ucans", () => ({ verify: vi.fn(), validate: vi.fn() }));
vi.mock("../../utils/contract", () => ({
  getIdentitySigningDid: vi.fn(),
  getOwnerDid: vi.fn(),
}));

describe("verifyCollaborationToken cache (R4a)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does NOT serve a cache hit across a different (sessionDid, documentId)", async () => {
    (ucans.verify as any).mockResolvedValue({ ok: true });
    const auth = new AuthService("did:server");

    await auth.verifyCollaborationToken("tok", "sessionA", "docA");
    await auth.verifyCollaborationToken("tok", "sessionB", "docB"); // same bearer token, different scope

    expect(ucans.verify).toHaveBeenCalledTimes(2);
  });

  it("serves a cache hit for the identical (token, sessionDid, documentId)", async () => {
    (ucans.verify as any).mockResolvedValue({ ok: true });
    const auth = new AuthService("did:server");

    await auth.verifyCollaborationToken("tok", "sessionA", "docA");
    await auth.verifyCollaborationToken("tok", "sessionA", "docA");

    expect(ucans.verify).toHaveBeenCalledTimes(1);
  });
});

describe("verifyIdentityToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("verifies the UCAN with rootIssuer = on-chain signingDid and a ddocId-bound capability", async () => {
    (getIdentitySigningDid as any).mockResolvedValue("did:key:zOwner");
    (ucans.verify as any).mockResolvedValue({ ok: true });
    const auth = new AuthService("did:server");

    const did = await auth.verifyIdentityToken("tok", "0xIdentity" as any, "ddoc-A");

    expect(ucans.verify).toHaveBeenCalledWith("tok", expect.objectContaining({
      audience: "did:server",
      requiredCapabilities: [expect.objectContaining({
        capability: expect.objectContaining({
          with: { scheme: "storage", hierPart: "ddoc-A" },
          can: { namespace: "collaboration", segments: ["OWN"] },
        }),
        rootIssuer: "did:key:zOwner",
      })],
    }));
    expect(did).toBe("did:key:zOwner");
  });

  it("returns null when the on-chain DID cannot be resolved", async () => {
    (getIdentitySigningDid as any).mockResolvedValue(null);
    const auth = new AuthService("did:server");
    expect(await auth.verifyIdentityToken("tok", "0xIdentity" as any, "ddoc-A")).toBeNull();
  });
});

describe("verifyOwnerOp (OR of two bound proofs)", () => {
  let auth: AuthService;
  beforeEach(() => {
    vi.clearAllMocks();
    auth = new AuthService("did:server");
  });

  it("authorizes via the identity path when signingDid == bound ownerIdentityDid", async () => {
    vi.spyOn(auth, "verifyIdentityToken").mockResolvedValue("did:key:zOwner");
    const ok = await auth.verifyOwnerOp({
      ddocId: "ddoc-A", boundOwnerIdentityDid: "did:key:zOwner", boundOwnerDid: "did:portal:owner",
      identityToken: "it", identityContractAddress: "0xIdentity" as any,
    });
    expect(ok).toBe(true);
  });

  // v1: the portal path is DEFERRED (member-forgeable for teams). A valid portal token alone must NOT authorize.
  it("does NOT authorize via the portal path in v1 (deferred — collaboratorKeys is member-forgeable)", async () => {
    vi.spyOn(auth, "verifyIdentityToken").mockResolvedValue(null);
    const ownerTokenSpy = vi.spyOn(auth, "verifyOwnerToken").mockResolvedValue("did:portal:owner");
    const ok = await auth.verifyOwnerOp({
      ddocId: "ddoc-A", boundOwnerIdentityDid: "did:key:zOwner", boundOwnerDid: "did:portal:owner",
      ownerToken: "ot", ownerAddress: "0xOwner" as any, portalAddress: "0xPortal" as any,
    });
    expect(ok).toBe(false);
    expect(ownerTokenSpy).not.toHaveBeenCalled();
  });

  // ATTACK 1: a valid identity UCAN from an identity that is NOT the bound owner must be rejected.
  it("REJECTS a valid identity UCAN whose signingDid != bound ownerIdentityDid (attacker's own contract)", async () => {
    vi.spyOn(auth, "verifyIdentityToken").mockResolvedValue("did:key:zAttacker"); // validly signed, wrong identity
    const ok = await auth.verifyOwnerOp({
      ddocId: "ddoc-A", boundOwnerIdentityDid: "did:key:zOwner", boundOwnerDid: "did:portal:owner",
      identityToken: "it", identityContractAddress: "0xAttacker" as any,
    });
    expect(ok).toBe(false);
  });

  // ATTACK 2: doc-scoping — verifyIdentityToken is called with THIS ddocId; a token minted for doc B fails.
  it("passes the caller's ddocId into verifyIdentityToken so a doc-B token can't authorize doc-A", async () => {
    const spy = vi.spyOn(auth, "verifyIdentityToken").mockResolvedValue(null);
    await auth.verifyOwnerOp({
      ddocId: "ddoc-A", boundOwnerIdentityDid: "did:key:zOwner", boundOwnerDid: "did:portal:owner",
      identityToken: "it", identityContractAddress: "0xIdentity" as any,
    });
    expect(spy).toHaveBeenCalledWith("it", "0xIdentity", "ddoc-A");
  });
});

describe("verifyEditUcan", () => {
  const serverDid = "did:key:zServerTest";
  const gateDid = "did:key:zGateTest";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the facts when verify passes and the fact docId matches", async () => {
    (ucans.verify as any).mockResolvedValue({ ok: true });
    (ucans.validate as any).mockResolvedValue({ payload: { fct: [{ docId: "doc-1", editGrantEpoch: 3, nullifier: "n-1" }] } });
    const svc = new AuthService(serverDid, gateDid);
    expect(await svc.verifyEditUcan("tok", "doc-1")).toEqual({ editGrantEpoch: 3, nullifier: "n-1" });
    // rooted at the pinned gate DID + the collab:EDIT capability
    expect(ucans.verify).toHaveBeenCalledWith("tok", expect.objectContaining({
      audience: serverDid,
      requiredCapabilities: [expect.objectContaining({
        capability: { with: { scheme: "collab", hierPart: "doc-1" }, can: { namespace: "collab", segments: ["EDIT"] } },
        rootIssuer: gateDid,
      })],
    }));
  });

  it("returns null when verify fails (wrong issuer / capability / audience)", async () => {
    (ucans.verify as any).mockResolvedValue({ ok: false });
    const svc = new AuthService(serverDid, gateDid);
    expect(await svc.verifyEditUcan("tok", "doc-1")).toBeNull();
    // verify gates validate: a failed verify must not reach fact extraction.
    expect(ucans.validate).not.toHaveBeenCalled();
  });

  it("returns null when the fact docId disagrees with the requested documentId", async () => {
    (ucans.verify as any).mockResolvedValue({ ok: true });
    (ucans.validate as any).mockResolvedValue({ payload: { fct: [{ docId: "doc-OTHER", editGrantEpoch: 3, nullifier: "n-1" }] } });
    const svc = new AuthService(serverDid, gateDid);
    expect(await svc.verifyEditUcan("tok", "doc-1")).toBeNull();
  });

  it("returns null (short-circuit, no verify call) when no gate DID is pinned", async () => {
    const svc = new AuthService(serverDid, undefined);
    expect(await svc.verifyEditUcan("tok", "doc-1")).toBeNull();
    expect(ucans.verify).not.toHaveBeenCalled();
  });
});
