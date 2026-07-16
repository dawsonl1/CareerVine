import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * deleteUserPhotoObjects (CAR-135 / R4.4): on account deletion the user's R2
 * contact photos must be enumerated by prefix and deleted, since R2 objects on
 * the public CDN don't cascade with the DB rows. The empty-userId guard is the
 * critical safety property: an empty prefix would list and delete every user's
 * photos.
 */

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-s3", () => {
  class S3Client {
    send = sendMock;
  }
  class ListObjectsV2Command {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }
  class DeleteObjectsCommand {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
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

import { deleteUserPhotoObjects } from "@/lib/r2";

interface ListPage {
  keys: string[];
  truncated?: boolean;
}

function program(pages: ListPage[]) {
  const listInputs: Record<string, unknown>[] = [];
  const deletedBatches: string[][] = [];
  const queue = [...pages];
  sendMock.mockImplementation(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    if (name === "ListObjectsV2Command") {
      listInputs.push(command.input);
      const page = queue.shift() ?? { keys: [], truncated: false };
      return {
        Contents: page.keys.map((Key) => ({ Key })),
        IsTruncated: Boolean(page.truncated),
        NextContinuationToken: page.truncated ? "next-token" : undefined,
      };
    }
    if (name === "DeleteObjectsCommand") {
      const objects = (command.input.Delete as { Objects: { Key: string }[] }).Objects;
      deletedBatches.push(objects.map((o) => o.Key));
      return {};
    }
    return {};
  });
  return { listInputs, deletedBatches };
}

beforeEach(() => {
  sendMock.mockReset();
});

describe("deleteUserPhotoObjects", () => {
  it("throws on a falsy userId rather than sweeping every user's photos", async () => {
    await expect(deleteUserPhotoObjects("")).rejects.toThrow(/userId is required/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("lists the user's prefix and deletes what it finds", async () => {
    const { listInputs, deletedBatches } = program([
      {
        keys: [
          "careervine/contact-photos/user-1/7-aaaaaaaa.webp",
          "careervine/contact-photos/user-1/9-bbbbbbbb.webp",
        ],
      },
    ]);

    await deleteUserPhotoObjects("user-1");

    expect(listInputs[0].Prefix).toBe("careervine/contact-photos/user-1/");
    expect(deletedBatches).toEqual([
      [
        "careervine/contact-photos/user-1/7-aaaaaaaa.webp",
        "careervine/contact-photos/user-1/9-bbbbbbbb.webp",
      ],
    ]);
  });

  it("follows pagination across continuation tokens", async () => {
    const { listInputs, deletedBatches } = program([
      { keys: ["careervine/contact-photos/user-1/1-a.webp"], truncated: true },
      { keys: ["careervine/contact-photos/user-1/2-b.webp"], truncated: false },
    ]);

    await deleteUserPhotoObjects("user-1");

    expect(listInputs).toHaveLength(2);
    expect(listInputs[1].ContinuationToken).toBe("next-token");
    expect(deletedBatches).toEqual([
      ["careervine/contact-photos/user-1/1-a.webp"],
      ["careervine/contact-photos/user-1/2-b.webp"],
    ]);
  });

  it("does not call delete when the user has no photos", async () => {
    const { deletedBatches } = program([{ keys: [] }]);
    await deleteUserPhotoObjects("user-1");
    expect(deletedBatches).toEqual([]);
  });

  it("swallows R2 errors so a delete path never fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    sendMock.mockRejectedValue(new Error("r2 down"));
    await expect(deleteUserPhotoObjects("user-1")).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
