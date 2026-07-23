import { describe, it, expect, vi, beforeEach } from "vitest";
import * as ucans from "@ucans/ucans";
import { AuthService } from "../../services/auth";
import { getIdentitySigningDid, getOwnerDid, refreshOwnerDid } from "../../utils/contract";

vi.mock("@ucans/ucans", () => ({ verify: vi.fn(), validate: vi.fn() }));
vi.mock("../../utils/contract", () => ({
  getIdentitySigningDid: vi.fn(),
  getOwnerDid: vi.fn(),
  refreshOwnerDid: vi.fn(),
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
    (ucans.validate as any).mockResolvedValue({ payload: { fct: [{ identityContractAddress: "0xIdentity" }] } });
    (getIdentitySigningDid as any).mockResolvedValue("did:key:zOwner");
    (ucans.verify as any).mockResolvedValue({ ok: true });
    const auth = new AuthService("did:server");

    const did = await auth.verifyIdentityToken("tok", "ddoc-A");

    expect(getIdentitySigningDid).toHaveBeenCalledWith("0xIdentity");
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
    (ucans.validate as any).mockResolvedValue({ payload: { fct: [{ identityContractAddress: "0xIdentity" }] } });
    (getIdentitySigningDid as any).mockResolvedValue(null);
    const auth = new AuthService("did:server");
    expect(await auth.verifyIdentityToken("tok", "ddoc-A")).toBeNull();
  });
});

describe("verifyOwnerToken rotation re-read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("re-reads the chain once when the cached DID fails verification and accepts the fresh DID", async () => {
    (getOwnerDid as any).mockResolvedValue("did:key:old");
    (refreshOwnerDid as any).mockResolvedValue("did:key:new");
    (ucans.verify as any).mockImplementation((_token: string, opts: any) =>
      Promise.resolve({ ok: opts.requiredCapabilities[0].rootIssuer === "did:key:new" })
    );
    const auth = new AuthService("did:server");

    const did = await auth.verifyOwnerToken("tok", "0xContract" as any, "0xCollab" as any);

    expect(did).toBe("did:key:new");
    expect(refreshOwnerDid).toHaveBeenCalledTimes(1);
    expect(refreshOwnerDid).toHaveBeenCalledWith("0xContract", "0xCollab");
  });

  it("rate-limits the re-read per (contract, address)", async () => {
    (getOwnerDid as any).mockResolvedValue("did:key:old");
    (refreshOwnerDid as any).mockResolvedValue("did:key:still-wrong");
    (ucans.verify as any).mockResolvedValue({ ok: false });
    const auth = new AuthService("did:server");

    const first = await auth.verifyOwnerToken("badtok", "0xContract" as any, "0xCollab" as any);
    const second = await auth.verifyOwnerToken("badtok", "0xContract" as any, "0xCollab" as any);

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(refreshOwnerDid).toHaveBeenCalledTimes(1);
  });

  it("returns the cached DID on the happy path without any re-read", async () => {
    (getOwnerDid as any).mockResolvedValue("did:key:owner");
    (ucans.verify as any).mockResolvedValue({ ok: true });
    const auth = new AuthService("did:server");

    const did = await auth.verifyOwnerToken("tok", "0xContract" as any, "0xCollab" as any);

    expect(did).toBe("did:key:owner");
    expect(refreshOwnerDid).not.toHaveBeenCalled();
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
      identityToken: "it",
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
      identityToken: "it",
    });
    expect(ok).toBe(false);
  });

  // ATTACK 2: doc-scoping — verifyIdentityToken is called with THIS ddocId; a token minted for doc B fails.
  it("passes the caller's ddocId into verifyIdentityToken so a doc-B token can't authorize doc-A", async () => {
    const spy = vi.spyOn(auth, "verifyIdentityToken").mockResolvedValue(null);
    await auth.verifyOwnerOp({
      ddocId: "ddoc-A", boundOwnerIdentityDid: "did:key:zOwner", boundOwnerDid: "did:portal:owner",
      identityToken: "it",
    });
    expect(spy).toHaveBeenCalledWith("it", "ddoc-A");
  });
});

describe("verifyEditUcan", () => {
  const serverDid = "did:key:zServerTest";
  const gateDid = "did:key:zGateTest";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the fact carries editGrantEpoch/nullifier but no editHandle (epoch-fact UCANs retired)", async () => {
    (ucans.verify as any).mockResolvedValue({ ok: true });
    (ucans.validate as any).mockResolvedValue({ payload: { fct: [{ docId: "doc-1", editGrantEpoch: 3, nullifier: "n-1" }] } });
    const svc = new AuthService(serverDid, gateDid);
    expect(await svc.verifyEditUcan("tok", "doc-1")).toBeNull();
    // rooted at the pinned gate DID + the collab:EDIT capability
    expect(ucans.verify).toHaveBeenCalledWith("tok", expect.objectContaining({
      audience: serverDid,
      requiredCapabilities: [expect.objectContaining({
        capability: { with: { scheme: "collab", hierPart: "doc-1" }, can: { namespace: "collab", segments: ["EDIT"] } },
        rootIssuer: gateDid,
      })],
    }));
  });

  it("returns {kind:'actor', editHandle, epoch:0} when the fact carries a matching docId + editHandle but no epoch", async () => {
    (ucans.verify as any).mockResolvedValue({ ok: true });
    (ucans.validate as any).mockResolvedValue({ payload: { fct: [{ docId: "doc-1", editHandle: "h-1" }] } });
    const svc = new AuthService(serverDid, gateDid);
    expect(await svc.verifyEditUcan("tok", "doc-1")).toEqual({ kind: "actor", editHandle: "h-1", epoch: 0 });
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
