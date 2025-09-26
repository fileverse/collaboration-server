import * as ucans from "@ucans/ucans";
import { getOwnerDid } from "../utils/contract";
import { Hex } from "viem";

export class AuthService {
  private serverDid: string;

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

  async verifyCollaborationToken(token: string, sessionDid: string) {
    try {
      const result = await ucans.verify(token, {
        audience: this.serverDid,
        requiredCapabilities: [
          {
            capability: {
              with: { scheme: "storage", hierPart: "collaboration" },
              can: { namespace: "collaboration", segments: ["COLLABORATE"] },
            },
            rootIssuer: sessionDid,
          },
        ],
      });

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
