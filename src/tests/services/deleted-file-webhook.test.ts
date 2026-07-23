import { describe, it, expect, vi, beforeEach } from "vitest";

const findById = vi.fn();

vi.mock("../../database/models", () => ({
  DocumentMetaModel: { findById: (...a: unknown[]) => findById(...a) },
  DocumentUpdateModel: {}, DocumentCommitModel: {}, CounterModel: {},
  SessionModel: {}, DocumentMirrorModel: {}, DocumentEditEpochModel: {},
}));

vi.mock("../../config", () => ({
  config: { webhook: { apiKey: "test-webhook-secret" } },
}));

import { createDeletedFileWebhookHandler } from "../../services/deleted-file-webhook";
import { config } from "../../config";

function res() {
  const r: any = {};
  r.status = vi.fn(() => r);
  r.json = vi.fn(() => r);
  return r;
}

function req(headers: Record<string, string>, body: unknown) {
  return {
    header: (name: string) => headers[name.toLowerCase()],
    body,
  } as any;
}

describe("POST /webhooks/file-deleted", () => {
  let mongodbStore: any;
  let onTombstoned: ReturnType<typeof vi.fn<[string], Promise<void>>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mongodbStore = { tombstoneDocument: vi.fn().mockResolvedValue(true) };
    onTombstoned = vi.fn<[string], Promise<void>>().mockResolvedValue(undefined);
  });

  it("tombstones and drops sessions on valid secret + portal match", async () => {
    findById.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ portalAddress: "0xAbC" }) }),
    });
    const handler = createDeletedFileWebhookHandler({ mongodbStore, onTombstoned });
    const r = res();

    await handler(
      req({ "x-webhook-api-key": "test-webhook-secret" }, { appFileId: "doc-1", portalAddress: "0xabc" }),
      r
    );

    expect(mongodbStore.tombstoneDocument).toHaveBeenCalledWith("doc-1", "onchain-delete");
    expect(onTombstoned).toHaveBeenCalledWith("doc-1");
    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.json).toHaveBeenCalledWith({ ok: true, matched: true });
  });

  it("401s on wrong secret and never tombstones", async () => {
    const handler = createDeletedFileWebhookHandler({ mongodbStore, onTombstoned });
    const r = res();

    await handler(
      req({ "x-webhook-api-key": "wrong-secret" }, { appFileId: "doc-1", portalAddress: "0xabc" }),
      r
    );

    expect(r.status).toHaveBeenCalledWith(401);
    expect(mongodbStore.tombstoneDocument).not.toHaveBeenCalled();
    expect(findById).not.toHaveBeenCalled();
  });

  it("no-ops on portal mismatch (colliding-appFileId defense) and never tombstones", async () => {
    findById.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ portalAddress: "0xOwnerPortal" }) }),
    });
    const handler = createDeletedFileWebhookHandler({ mongodbStore, onTombstoned });
    const r = res();

    await handler(
      req({ "x-webhook-api-key": "test-webhook-secret" }, { appFileId: "doc-1", portalAddress: "0xAttackerPortal" }),
      r
    );

    expect(mongodbStore.tombstoneDocument).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.json).toHaveBeenCalledWith({ ok: true, matched: false });
  });

  it("no-ops on unknown appFileId and never tombstones", async () => {
    findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) });
    const handler = createDeletedFileWebhookHandler({ mongodbStore, onTombstoned });
    const r = res();

    await handler(
      req({ "x-webhook-api-key": "test-webhook-secret" }, { appFileId: "missing", portalAddress: "0xabc" }),
      r
    );

    expect(mongodbStore.tombstoneDocument).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.json).toHaveBeenCalledWith({ ok: true, matched: false });
  });

  it("401s when config.webhook.apiKey is unset, even with a header, and never tombstones", async () => {
    const original = config.webhook.apiKey;
    config.webhook.apiKey = undefined;
    try {
      const handler = createDeletedFileWebhookHandler({ mongodbStore, onTombstoned });
      const r = res();

      await handler(
        req({ "x-webhook-api-key": "test-webhook-secret" }, { appFileId: "doc-1", portalAddress: "0xabc" }),
        r
      );

      expect(r.status).toHaveBeenCalledWith(401);
      expect(mongodbStore.tombstoneDocument).not.toHaveBeenCalled();
      expect(findById).not.toHaveBeenCalled();
    } finally {
      config.webhook.apiKey = original;
    }
  });

  it("400s when appFileId or portalAddress is missing", async () => {
    const handler = createDeletedFileWebhookHandler({ mongodbStore, onTombstoned });
    const r = res();

    await handler(req({ "x-webhook-api-key": "test-webhook-secret" }, { appFileId: "doc-1" }), r);

    expect(r.status).toHaveBeenCalledWith(400);
    expect(mongodbStore.tombstoneDocument).not.toHaveBeenCalled();
    expect(findById).not.toHaveBeenCalled();
  });
});
