import * as ucans from "@ucans/ucans";
import { getIdentitySigningDid, getOwnerDid } from "../utils/contract";
import { Hex } from "viem";
import NodeCache from "node-cache";
import { config } from "../config";

export class AuthService {
  private serverDid: string;
  private gateDid?: string;
  private collaborationTokenCache = new NodeCache({ stdTTL: 3600 });

  constructor(serverDid: string, gateDid?: string) {
    this.serverDid = serverDid;
    this.gateDid = gateDid;
  }

  getServerDid(): string {
    return this.serverDid;
  }

  async verifyOwnerToken(token: string, contractAddress: Hex, collaboratorAddress: Hex) {
    try {
      const ownerDid = await getOwnerDid(contractAddress, collaboratorAddress);
      if (!ownerDid) return null;

      const result = await ucans.verify(token, {
        audience: this.serverDid,
        requiredCapabilities: [
          {
            capability: {
              with: { scheme: "storage", hierPart: contractAddress.toLowerCase() },
              can: { namespace: "collaboration", segments: ["CREATE"] },
            },
            rootIssuer: ownerDid,
          },
        ],
      });

      if (result.ok) {
        return ownerDid;
      }
      return null;
    } catch (error) {
      console.error("UCAN verification error:", error);
      return null;
    }
  }

  async verifyCollaborationToken(token: string, sessionDid: string, documentId: string) {
    const cacheKey = `${token}:${sessionDid}:${documentId}`;
    const cachedResult = this.collaborationTokenCache.get<boolean>(cacheKey);
    if (cachedResult !== undefined) {
      return cachedResult;
    }

    try {
      const result = await ucans.verify(token, {
        audience: this.serverDid,

        requiredCapabilities: [
          {
            capability: {
              with: { scheme: "storage", hierPart: documentId },
              can: { namespace: "collaboration", segments: ["COLLABORATE"] },
            },
            rootIssuer: sessionDid,
          },
        ],
      });

      if (result.ok) {
        this.collaborationTokenCache.set(cacheKey, true);
      }
      return result.ok;
    } catch (error) {
      console.error("UCAN verification error:", error);
      return false;
    }
  }

  /**
   * Verify a gate-minted edit-admission UCAN, rooted at the pinned gate DID. Returns the
   * signed facts (editGrantEpoch, nullifier) or null. The epoch comes from the token, never a client arg.
   */
  async verifyEditUcan(
    token: string,
    documentId: string
  ): Promise<{ editGrantEpoch: number; nullifier: string } | null> {
    if (!this.gateDid) return null; // GP editing disabled until GATE_DID is pinned
    try {
      const result = await ucans.verify(token, {
        audience: this.serverDid,
        requiredCapabilities: [
          {
            capability: {
              with: { scheme: "collab", hierPart: documentId },
              can: { namespace: "collab", segments: ["EDIT"] },
            },
            rootIssuer: this.gateDid,
          },
        ],
      });
      if (!result.ok) return null;

      const parsed = await ucans.validate(token);
      const fact = ((parsed.payload.fct ?? [])[0] ?? {}) as {
        docId?: string;
        editGrantEpoch?: number;
        nullifier?: string;
      };
      if (
        fact.docId !== documentId ||
        typeof fact.editGrantEpoch !== "number" ||
        typeof fact.nullifier !== "string"
      ) {
        return null;
      }
      return { editGrantEpoch: fact.editGrantEpoch, nullifier: fact.nullifier };
    } catch (error) {
      console.error("Edit UCAN verification error:", error);
      return null;
    }
  }

  async verifyIdentityToken(
    token: string,
    identityContractAddress: Hex,
    ddocId: string
  ): Promise<string | null> {
    try {
      const signingDid = await getIdentitySigningDid(identityContractAddress);
      if (!signingDid) return null;

      const result = await ucans.verify(token, {
        audience: this.serverDid,
        requiredCapabilities: [
          {
            capability: {
              with: { scheme: "storage", hierPart: ddocId },
              can: { namespace: "collaboration", segments: ["OWN"] },
            },
            rootIssuer: signingDid,
          },
        ],
      });
      return result.ok ? signingDid : null;
    } catch (error) {
      console.error("Identity token verification error:", error);
      return null;
    }
  }

  async verifyOwnerOp(params: {
    ddocId: string;
    boundOwnerIdentityDid: string | null;
    boundOwnerDid: string | null;
    identityToken?: string;
    identityContractAddress?: Hex;
    ownerToken?: string;
    ownerAddress?: Hex;
    portalAddress?: Hex;
  }): Promise<boolean> {
    // Path 1 — bound identity (creator). The `=== boundOwnerIdentityDid` compare is MANDATORY.
    if (params.identityToken && params.identityContractAddress && params.boundOwnerIdentityDid) {
      const signingDid = await this.verifyIdentityToken(
        params.identityToken,
        params.identityContractAddress,
        params.ddocId
      );
      if (signingDid && signingDid === params.boundOwnerIdentityDid) return true;
    }

    // Path 2 — portal owner-of-record (team creator-left fallback): ⚠ DEFERRED in v1, NOT authorized here.
    // The only portal proof available today is verifyOwnerToken → getOwnerDid → `collaboratorKeys`, which
    // for a TEAM/workspace portal returns the SHARED `workspaceCollabDid` — and EVERY member holds its
    // secret (`workspaceCollabSecret`, distributed in the invite payload). So any member could satisfy
    // `== boundOwnerDid`, reopening H2/B5 for teams (code-verified 2026-07-08:
    // mint-team-portal.ts:219-246, buildJoinerSlice.ts:149-156, keystore/helpers.ts:137-138). A correct
    // portal-owner proof must pin `portal.owner()` (the ASA Safe, ERC-1271-capable) via an owner-signed
    // message — net-new client + server work. Until then owner-ops authorize on the (per-creator-distinct,
    // unforgeable) IDENTITY proof ONLY; a team doc whose creator has left cannot be owner-op'd in v1.

    return false;
  }
}

export const authService = new AuthService(
  process.env.SERVER_DID || "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
  config.gate.did
);
