import { describe, it, expect } from "vitest";
import * as ucans from "@ucans/ucans";
import { AuthService } from "../../services/auth";

async function mint(gate: ucans.EdKeypair, serverDid: string, facts: Record<string, unknown>[], docId: string) {
  const u = await ucans.build({
    issuer: gate, audience: serverDid,
    capabilities: [{ with: { scheme: "collab", hierPart: docId }, can: { namespace: "collab", segments: ["EDIT"] } }],
    facts, lifetimeInSeconds: 3600,
  });
  return ucans.encode(u);
}

describe("verifyEditUcan epoch fact", () => {
  it("returns the epoch from the fact", async () => {
    const gate = await ucans.EdKeypair.create();
    const server = await ucans.EdKeypair.create();
    const svc = new AuthService(server.did(), gate.did());
    const token = await mint(gate, server.did(), [{ docId: "doc-1", editHandle: "h1", epoch: 3 }], "doc-1");
    expect(await svc.verifyEditUcan(token, "doc-1")).toEqual({ kind: "actor", editHandle: "h1", epoch: 3 });
  });

  it("defaults epoch to 0 when the fact omits it (pre-Plan-1 UCAN)", async () => {
    const gate = await ucans.EdKeypair.create();
    const server = await ucans.EdKeypair.create();
    const svc = new AuthService(server.did(), gate.did());
    const token = await mint(gate, server.did(), [{ docId: "doc-1", editHandle: "h1" }], "doc-1");
    expect(await svc.verifyEditUcan(token, "doc-1")).toEqual({ kind: "actor", editHandle: "h1", epoch: 0 });
  });
});
