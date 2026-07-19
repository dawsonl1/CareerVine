import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * sweepR2PhotoOrphans (CAR-156): the daily sweep's R2 pass. Contact photos on
 * the public CDN with no contacts.photo_url pointing at them are orphans.
 * Safety properties under test: complete-live-set-or-abort (a contacts read
 * error or R2 listing error deletes NOTHING), the 24h min-age guard with
 * unknown-age-fails-safe, exact-key matching, and dry-run.
 */

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-s3", () => {
  class S3Client {
    send = sendMock;
  }
  class ListObjectsV2Command {
    constructor(public input: Record<string, unknown>) {}
  }
  class DeleteObjectsCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class PutObjectCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class DeleteObjectCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return { S3Client, ListObjectsV2Command, DeleteObjectsCommand, PutObjectCommand, DeleteObjectCommand };
});

process.env.R2_ACCOUNT_ID = "acct";
process.env.R2_ACCESS_KEY_ID = "akid";
process.env.R2_SECRET_ACCESS_KEY = "secret";
process.env.R2_BUCKET = "bucket";
process.env.R2_PUBLIC_BASE_URL = "https://assets.careervine.app";

import { sweepR2PhotoOrphans, DEFAULT_MIN_AGE_MS } from "@/lib/storage-sweep";

const NOW = Date.parse("2026-07-19T12:00:00.000Z");
const OLD = new Date("2026-07-10T00:00:00.000Z"); // well past the min-age cutoff
const FRESH = new Date("2026-07-19T11:30:00.000Z"); // 30 min old — inside the guard

const PREFIX = "careervine/contact-photos/";
const liveKey = `${PREFIX}u1/7-live1234.webp`;
const orphanKey = `${PREFIX}u1/8-orph1234.webp`;
const freshKey = `${PREFIX}u2/9-fresh123.webp`;

interface R2Listing {
  keys: Array<{ key: string; lastModified: Date | null }>;
  error?: string;
}

function programR2(listing: R2Listing) {
  const deletedBatches: string[][] = [];
  sendMock.mockImplementation(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    if (name === "ListObjectsV2Command") {
      if (listing.error) throw new Error(listing.error);
      return {
        Contents: listing.keys.map((k) => ({ Key: k.key, LastModified: k.lastModified ?? undefined })),
        IsTruncated: false,
      };
    }
    if (name === "DeleteObjectsCommand") {
      const objects = (command.input.Delete as { Objects: { Key: string }[] }).Objects;
      deletedBatches.push(objects.map((o) => o.Key));
      return {};
    }
    return {};
  });
  return { deletedBatches };
}

function mockService(cfg: { photoUrls?: (string | null)[]; readErrorMessage?: string }) {
  const builder: Record<string, unknown> = {};
  let from = 0;
  let to = Infinity;
  const rows = (cfg.photoUrls ?? []).map((photo_url) => ({ photo_url }));
  Object.assign(builder, {
    select: () => builder,
    not: () => builder,
    order: () => builder,
    range: (f: number, t: number) => {
      from = f;
      to = t;
      return builder;
    },
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve(
        cfg.readErrorMessage
          ? { data: null, error: { message: cfg.readErrorMessage } }
          : { data: rows.slice(from, to + 1), error: null },
      ).then(resolve),
  });
  return { from: () => builder } as unknown as SupabaseClient;
}

const url = (key: string) => `https://assets.careervine.app/${key}`;

beforeEach(() => {
  sendMock.mockReset();
});

describe("sweepR2PhotoOrphans", () => {
  it("removes an old orphan and keeps live and young keys", async () => {
    const { deletedBatches } = programR2({
      keys: [
        { key: liveKey, lastModified: OLD },
        { key: orphanKey, lastModified: OLD },
        { key: freshKey, lastModified: FRESH },
      ],
    });
    const service = mockService({ photoUrls: [url(liveKey), null] });

    const result = await sweepR2PhotoOrphans({ service, now: () => NOW });

    expect(result.scanned).toBe(3);
    expect(result.live).toBe(1);
    expect(result.skippedRecent).toBe(1);
    expect(result.removed).toEqual([orphanKey]);
    expect(result.errors).toEqual([]);
    expect(deletedBatches).toEqual([[orphanKey]]);
  });

  it("treats an unknown LastModified as too recent to delete (fails safe)", async () => {
    const { deletedBatches } = programR2({
      keys: [{ key: orphanKey, lastModified: null }],
    });
    const service = mockService({ photoUrls: [] });

    const result = await sweepR2PhotoOrphans({ service, now: () => NOW });

    expect(result.skippedRecent).toBe(1);
    expect(result.removed).toEqual([]);
    expect(deletedBatches).toEqual([]);
  });

  it("aborts without deleting when the contacts read fails (incomplete live set)", async () => {
    const { deletedBatches } = programR2({
      keys: [{ key: orphanKey, lastModified: OLD }],
    });
    const service = mockService({ readErrorMessage: "connection reset" });

    const result = await sweepR2PhotoOrphans({ service, now: () => NOW });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("contacts query");
    expect(result.removed).toEqual([]);
    expect(deletedBatches).toEqual([]);
  });

  it("aborts without deleting when the R2 listing fails", async () => {
    const { deletedBatches } = programR2({ keys: [], error: "R2 unavailable" });
    const service = mockService({ photoUrls: [] });

    const result = await sweepR2PhotoOrphans({ service, now: () => NOW });

    expect(result.errors).toEqual(["R2 unavailable"]);
    expect(result.removed).toEqual([]);
    expect(deletedBatches).toEqual([]);
  });

  it("reports orphans without deleting in dry-run mode", async () => {
    const { deletedBatches } = programR2({
      keys: [{ key: orphanKey, lastModified: OLD }],
    });
    const service = mockService({ photoUrls: [] });

    const result = await sweepR2PhotoOrphans({ service, dryRun: true, now: () => NOW });

    expect(result.removed).toEqual([orphanKey]);
    expect(deletedBatches).toEqual([]);
  });

  it("honors a custom minAgeMs cutoff", async () => {
    const justOverDefault = new Date(NOW - DEFAULT_MIN_AGE_MS - 60_000);
    const { deletedBatches } = programR2({
      keys: [{ key: orphanKey, lastModified: justOverDefault }],
    });
    const service = mockService({ photoUrls: [] });

    // Double the window: the same object is now inside the guard.
    const result = await sweepR2PhotoOrphans({
      service,
      minAgeMs: DEFAULT_MIN_AGE_MS * 2,
      now: () => NOW,
    });

    expect(result.skippedRecent).toBe(1);
    expect(deletedBatches).toEqual([]);
  });
});
