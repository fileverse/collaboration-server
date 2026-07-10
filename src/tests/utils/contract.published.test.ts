import { describe, it, expect, vi, beforeEach } from "vitest";
import { publicClient, resolvePublishedDocumentIds } from "../../utils/contract";

describe("resolvePublishedDocumentIds", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns [] for empty input without calling the chain", async () => {
    const spy = vi.spyOn(publicClient, "multicall");
    const out = await resolvePublishedDocumentIds([]);
    expect(out.size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("marks published incl. the 0-indexed first file, excludes unpublished mapping-to-0", async () => {
    // Phase 1: appFileIdToFileId -> fileId. A -> 0 (first file), B -> 3, C -> 0 (default; NOT published).
    // Phase 2: files(fileId).appFileId (tuple index 0). files(0) belongs to A ("da"); files(3) to B ("db").
    const spy = vi
      .spyOn(publicClient, "multicall")
      .mockResolvedValueOnce([
        { status: "success", result: 0n },
        { status: "success", result: 3n },
        { status: "success", result: 0n },
      ] as any)
      .mockResolvedValueOnce([
        { status: "success", result: ["da", 0, "m", "c", "g", 1n, "0x0"] },
        { status: "success", result: ["db", 0, "m", "c", "g", 1n, "0x0"] },
        { status: "success", result: ["da", 0, "m", "c", "g", 1n, "0x0"] },
      ] as any);

    const refs = [
      { documentId: "da", portalAddress: "0xP" },
      { documentId: "db", portalAddress: "0xP" },
      { documentId: "dc", portalAddress: "0xP" },
    ];
    const out = await resolvePublishedDocumentIds(refs);

    expect(spy).toHaveBeenCalledTimes(2);
    expect([...out].sort()).toEqual(["da", "db"]);
  });

  it("treats a failed phase-1 sub-call as unpublished", async () => {
    vi.spyOn(publicClient, "multicall")
      .mockResolvedValueOnce([{ status: "failure", error: new Error("rpc") }] as any)
      .mockResolvedValueOnce([] as any);
    const out = await resolvePublishedDocumentIds([{ documentId: "dx", portalAddress: "0xP" }]);
    expect(out.size).toBe(0);
  });
});
