import * as ucans from "@ucans/ucans";
import { getOwnerDid } from "../utils/contract";
import { Hex } from "viem";
import NodeCache from "node-cache";

export class AuthService {
  private serverDid: string;
  private collaborationTokenCache = new NodeCache({ stdTTL: 3600 });

  constructor(serverDid: string) {
    this.serverDid = serverDid;
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
    const cacheKey = token;
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
}

export const authService = new AuthService(
  process.env.SERVER_DID || "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"
);
