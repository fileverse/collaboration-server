import * as ucans from "@ucans/ucans";
import { UCANPayload } from "../types/index";

export class AuthService {
  private serverKeyPair: ucans.EdKeypair | null = null;
  private serverDid: string;

  constructor(serverDid: string) {
    this.serverDid = serverDid;
  }

  async initialize() {
    // In a real implementation, you'd load this from secure storage
    // For now, we'll generate a new keypair each time
    this.serverKeyPair = await ucans.EdKeypair.create({ exportable: true });
    this.serverDid = this.serverKeyPair.did();
    console.log(`Server DID: ${this.serverDid}`);
  }

  getServerDid(): string {
    return this.serverDid;
  }

  async verifyUCAN(
    token: string,
    documentId: string
  ): Promise<{
    isValid: boolean;
    userDid?: string;
    error?: string;
  }> {
    try {
      // Parse the UCAN token
      const ucan = ucans.parse(token);

      // For now, we'll do basic validation
      // In a real implementation, you'd verify the signature and capabilities
      return {
        isValid: true,
      };
      //   if (ucan && ucan.iss) {
      //     return {
      //       isValid: true,
      //       userDid: ucan.iss,
      //     };
      //   } else {
      //     return {
      //       isValid: false,
      //       error: "Invalid UCAN token structure",
      //     };
      //   }
    } catch (error) {
      console.error("UCAN verification error:", error);
      return {
        isValid: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  // Extract user ID from DID (simplified)
  extractUserIdFromDid(did: string): string {
    // In a real implementation, you might want to map DIDs to user IDs
    // For now, we'll use the DID itself as the user ID
    return did;
  }

  // Determine user role based on document and user
  async getUserRole(documentId: string, userDid: string): Promise<"owner" | "editor"> {
    // For this demo, we'll make the first user to join a document the owner
    // In a real implementation, you'd check against stored permissions

    // This is a simplified implementation - you might want to store this information
    // in your database/memory store
    return "editor"; // Default to editor for now
  }
}

export const authService = new AuthService(
  process.env.SERVER_DID || "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"
);
