import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  sweepStorageOrphans,
  removeUserStorageObjects,
  DEFAULT_MIN_AGE_MS,
} from "@/lib/storage-sweep";

const NOW = Date.parse("2026-07-11T12:00:00.000Z");
const OLD = "2026-07-01T00:00:00.000Z"; // well past the min-age cutoff
const FRESH = "2026-07-11T11:30:00.000Z"; // 30 min old — inside the guard

type StorageItem = { name: string; id: string | null; created_at?: string };

interface MockConfig {
  /** bucket -> prefix -> listed items (folders have id: null). */
  storage: Record<string, Record<string, StorageItem[]>>;
  /** object_paths present in the attachments table (bucket='attachments'). */
  attachmentPaths?: string[];
  /** pipeline_applications rows. */
  applicationRows?: Array<{ resume_path: string | null; cover_letter_path: string | null }>;
  /** If set, every storage remove() fails with this message. */
  removeErrorMessage?: string;
}

function file(name: string, created_at = OLD): StorageItem {
  return { name, id: `id-${name}`, created_at };
}

function folder(name: string): StorageItem {
  return { name, id: null };
}

function mockService(cfg: MockConfig) {
  const removeCalls: Array<{ bucket: string; paths: string[] }> = [];

  const storageFrom = (bucket: string) => ({
    list: async (prefix: string, opts: { limit: number; offset: number }) => {
      const items = cfg.storage[bucket]?.[prefix] ?? [];
      return { data: items.slice(opts.offset, opts.offset + opts.limit), error: null };
    },
    remove: async (paths: string[]) => {
      if (cfg.removeErrorMessage) {
        return { data: null, error: { message: cfg.removeErrorMessage } };
      }
      removeCalls.push({ bucket, paths });
      return { data: paths.map((p) => ({ name: p })), error: null };
    },
  });

  function makeBuilder(table: string) {
    let from = 0;
    let to = Infinity;
    const rows =
      table === "attachments"
        ? (cfg.attachmentPaths ?? []).map((p) => ({ object_path: p }))
        : (cfg.applicationRows ?? []);
    const builder: Record<string, unknown> = {};
    Object.assign(builder, {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      range: (f: number, t: number) => {
        from = f;
        to = t;
        return builder;
      },
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: rows.slice(from, to + 1), error: null }).then(resolve),
    });
    return builder;
  }

  const service = {
    storage: { from: storageFrom },
    from: (table: string) => makeBuilder(table),
  } as unknown as SupabaseClient;

  return { service, removeCalls };
}

const EMPTY_APP_BUCKET = { "": [] as StorageItem[] };

describe("sweepStorageOrphans", () => {
  it("removes orphans and keeps objects with a matching row", async () => {
    const { service, removeCalls } = mockService({
      storage: {
        attachments: {
          "": [folder("userA")],
          userA: [file("live.pdf"), file("orphan.pdf")],
        },
        "application-files": EMPTY_APP_BUCKET,
      },
      attachmentPaths: ["userA/live.pdf"],
    });

    const result = await sweepStorageOrphans({ service, now: () => NOW });

    expect(result.attachments).toEqual({
      scanned: 2,
      live: 1,
      skippedRecent: 0,
      removed: ["userA/orphan.pdf"],
      errors: [],
    });
    expect(removeCalls).toEqual([{ bucket: "attachments", paths: ["userA/orphan.pdf"] }]);
  });

  it("never deletes objects younger than the min-age guard", async () => {
    const { service, removeCalls } = mockService({
      storage: {
        attachments: {
          "": [folder("userA")],
          userA: [file("just-uploaded.pdf", FRESH)],
        },
        "application-files": EMPTY_APP_BUCKET,
      },
      attachmentPaths: [],
    });

    const result = await sweepStorageOrphans({ service, now: () => NOW });

    expect(result.attachments.skippedRecent).toBe(1);
    expect(result.attachments.removed).toEqual([]);
    expect(removeCalls).toEqual([]);
  });

  it("fails safe: skips orphans with a null or unparseable created_at", async () => {
    const { service, removeCalls } = mockService({
      storage: {
        attachments: {
          "": [folder("userA")],
          userA: [
            { name: "no-timestamp.pdf", id: "id-x", created_at: undefined },
            { name: "bad-timestamp.pdf", id: "id-y", created_at: "not-a-date" },
          ],
        },
        "application-files": EMPTY_APP_BUCKET,
      },
      attachmentPaths: [],
    });

    const result = await sweepStorageOrphans({ service, now: () => NOW });

    expect(result.attachments.skippedRecent).toBe(2);
    expect(result.attachments.removed).toEqual([]);
    expect(removeCalls).toEqual([]);
  });

  it("deletes an orphan exactly min-age old on the next day's run", async () => {
    const justOldEnough = new Date(NOW - DEFAULT_MIN_AGE_MS - 1).toISOString();
    const { service } = mockService({
      storage: {
        attachments: { "": [folder("u")], u: [file("f.txt", justOldEnough)] },
        "application-files": EMPTY_APP_BUCKET,
      },
    });

    const result = await sweepStorageOrphans({ service, now: () => NOW });
    expect(result.attachments.removed).toEqual(["u/f.txt"]);
  });

  it("dry-run reports orphans without calling remove", async () => {
    const { service, removeCalls } = mockService({
      storage: {
        attachments: { "": [folder("userA")], userA: [file("orphan.pdf")] },
        "application-files": EMPTY_APP_BUCKET,
      },
    });

    const result = await sweepStorageOrphans({ service, dryRun: true, now: () => NOW });

    expect(result.attachments.removed).toEqual(["userA/orphan.pdf"]);
    expect(removeCalls).toEqual([]);
  });

  it("diffs application-files against pipeline_applications paths", async () => {
    const { service, removeCalls } = mockService({
      storage: {
        attachments: { "": [] },
        "application-files": {
          "": [folder("userB")],
          userB: [file("resume.pdf"), file("cover.pdf"), file("stale.pdf")],
        },
      },
      applicationRows: [
        { resume_path: "userB/resume.pdf", cover_letter_path: "userB/cover.pdf" },
      ],
    });

    const result = await sweepStorageOrphans({ service, now: () => NOW });

    expect(result["application-files"].live).toBe(2);
    expect(result["application-files"].removed).toEqual(["userB/stale.pdf"]);
    expect(removeCalls).toEqual([{ bucket: "application-files", paths: ["userB/stale.pdf"] }]);
  });

  it("paginates storage listings past one page", async () => {
    const manyFiles = Array.from({ length: 150 }, (_, i) => file(`f${i}.txt`));
    const { service } = mockService({
      storage: {
        attachments: { "": [folder("u")], u: manyFiles },
        "application-files": EMPTY_APP_BUCKET,
      },
    });

    const result = await sweepStorageOrphans({ service, now: () => NOW });
    expect(result.attachments.scanned).toBe(150);
    expect(result.attachments.removed).toHaveLength(150);
  });

  it("records remove failures as errors instead of throwing", async () => {
    const { service } = mockService({
      storage: {
        attachments: { "": [folder("u")], u: [file("orphan.txt")] },
        "application-files": EMPTY_APP_BUCKET,
      },
      removeErrorMessage: "boom",
    });

    const result = await sweepStorageOrphans({ service, now: () => NOW });
    expect(result.attachments.errors).toEqual(["remove batch: boom"]);
    expect(result.attachments.removed).toEqual([]);
  });

  it("handles top-level objects with no folder (e.g. _smoke leftovers)", async () => {
    const { service } = mockService({
      storage: {
        attachments: { "": [file("stray.txt")] },
        "application-files": EMPTY_APP_BUCKET,
      },
    });

    const result = await sweepStorageOrphans({ service, now: () => NOW });
    expect(result.attachments.removed).toEqual(["stray.txt"]);
  });
});

describe("removeUserStorageObjects", () => {
  it("removes everything under the user's folder in both buckets", async () => {
    const { service, removeCalls } = mockService({
      storage: {
        attachments: { userA: [file("a.pdf"), file("b.pdf", FRESH)] },
        "application-files": { userA: [file("resume.pdf")] },
      },
    });

    await removeUserStorageObjects(service, "userA");

    expect(removeCalls).toEqual([
      { bucket: "attachments", paths: ["userA/a.pdf", "userA/b.pdf"] },
      { bucket: "application-files", paths: ["userA/resume.pdf"] },
    ]);
  });

  it("also clears the legacy contact-photos bucket on account deletion", async () => {
    const { service, removeCalls } = mockService({
      storage: {
        attachments: { userA: [file("a.pdf")] },
        "application-files": {},
        "contact-photos": { userA: [file("42.jpg")] },
      },
    });

    await removeUserStorageObjects(service, "userA");

    expect(removeCalls).toContainEqual({ bucket: "contact-photos", paths: ["userA/42.jpg"] });
  });

  it("throws on a falsy userId rather than wiping the whole bucket", async () => {
    const { service, removeCalls } = mockService({
      storage: { attachments: { "": [file("a.pdf")] }, "application-files": {} },
    });
    await expect(removeUserStorageObjects(service, "")).rejects.toThrow(/userId is required/);
    expect(removeCalls).toEqual([]);
  });

  it("swallows storage errors (sweep self-heals)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { service } = mockService({
      storage: { attachments: { userA: [file("a.pdf")] }, "application-files": {} },
      removeErrorMessage: "boom",
    });

    await expect(removeUserStorageObjects(service, "userA")).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
