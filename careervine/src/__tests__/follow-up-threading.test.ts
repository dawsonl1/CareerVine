import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CAR-214: follow-ups must carry RFC 822 Message-IDs in In-Reply-To /
 * References so the RECIPIENT's client threads them onto the original
 * conversation. The old code passed `original_gmail_message_id` — a Gmail API
 * id like `19f6701a3d3b3935`, which names no Message-ID anywhere — so every
 * auto-sent follow-up arrived as a brand new conversation.
 *
 * The bar these tests hold: a bare Gmail id must NEVER reach the headers, and
 * an unresolvable thread must produce no headers rather than a bogus one.
 */

const threadsGet = vi.fn();
vi.mock("@/lib/gmail-send-core", () => ({
  getGmailClient: async () => ({ users: { threads: { get: threadsGet } } }),
}));

const { resolveFollowUpThreadHeaders, THREADING_METADATA_HEADERS } = await import(
  "@/lib/follow-up-threading"
);

/** A thread whose messages carry the given Message-ID header values. */
function thread(...messageIds: Array<string | null>) {
  return {
    messages: messageIds.map((id) => ({
      payload: { headers: id === null ? [] : [{ name: "Message-ID", value: id }] },
    })),
  };
}

beforeEach(() => {
  threadsGet.mockReset();
});

describe("resolveFollowUpThreadHeaders", () => {
  it("replies to the newest message and references the whole chain", async () => {
    const headers = await resolveFollowUpThreadHeaders("u1", "t1", {
      thread: thread("<a@mail.gmail.com>", "<b@mail.gmail.com>", "<c@mail.gmail.com>"),
    });

    // In-Reply-To names the latest turn; References carries the chain oldest
    // first, which is what lets a client that missed a middle message still
    // attach this one to the root.
    expect(headers.inReplyTo).toBe("<c@mail.gmail.com>");
    expect(headers.references).toBe("<a@mail.gmail.com> <b@mail.gmail.com> <c@mail.gmail.com>");
  });

  it("adds the angle brackets a sender omitted", async () => {
    const headers = await resolveFollowUpThreadHeaders("u1", "t1", {
      thread: thread("bare@mail.gmail.com"),
    });
    expect(headers.inReplyTo).toBe("<bare@mail.gmail.com>");
  });

  it("drops a bare Gmail API id instead of shipping it as a msg-id", async () => {
    // The regression under test. A Gmail id has no '@', so it can never be a
    // msg-id — wrapping it in brackets would just produce a different bogus
    // header, so it must be discarded and leave the headers unset.
    const headers = await resolveFollowUpThreadHeaders("u1", "t1", {
      thread: thread("19f6701a3d3b3935"),
    });
    expect(headers).toEqual({});
  });

  it("keeps the real ids when only some messages carry a usable one", async () => {
    const headers = await resolveFollowUpThreadHeaders("u1", "t1", {
      thread: thread("<a@mail.gmail.com>", "19f6701a3d3b3935", null, "<d@mail.gmail.com>"),
    });
    expect(headers.inReplyTo).toBe("<d@mail.gmail.com>");
    expect(headers.references).toBe("<a@mail.gmail.com> <d@mail.gmail.com>");
  });

  it("de-dupes repeated ids so References cannot list one twice", async () => {
    const headers = await resolveFollowUpThreadHeaders("u1", "t1", {
      thread: thread("<a@mail.gmail.com>", "<a@mail.gmail.com>", "<b@mail.gmail.com>"),
    });
    expect(headers.references).toBe("<a@mail.gmail.com> <b@mail.gmail.com>");
  });

  it("rejects a value carrying CR/LF rather than letting it near a header", async () => {
    const headers = await resolveFollowUpThreadHeaders("u1", "t1", {
      thread: thread("<a@mail.gmail.com>\r\nBcc: evil@example.com"),
    });
    expect(headers).toEqual({});
  });

  it("returns nothing for a thread with no messages", async () => {
    expect(await resolveFollowUpThreadHeaders("u1", "t1", { thread: thread() })).toEqual({});
  });

  it("returns nothing when there is no thread id yet", async () => {
    // The pre-send state: a sequence queued behind a scheduled email has a
    // null thread_id until that email actually sends.
    expect(await resolveFollowUpThreadHeaders("u1", null)).toEqual({});
    expect(threadsGet).not.toHaveBeenCalled();
  });

  it("fetches the thread itself when the caller has none, asking for Message-ID", async () => {
    threadsGet.mockResolvedValue({ data: thread("<a@mail.gmail.com>") });

    const headers = await resolveFollowUpThreadHeaders("u1", "t1");

    expect(headers.inReplyTo).toBe("<a@mail.gmail.com>");
    expect(threadsGet).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "t1",
        format: "metadata",
        metadataHeaders: [...THREADING_METADATA_HEADERS],
      }),
    );
  });

  it("never fetches when the caller already supplied the thread", async () => {
    // The cron's whole reason for passing its reply-detection thread through:
    // correct threading must not cost a second Gmail round trip per send.
    await resolveFollowUpThreadHeaders("u1", "t1", { thread: thread("<a@mail.gmail.com>") });
    expect(threadsGet).not.toHaveBeenCalled();
  });

  it("omits the headers when the thread fetch fails", async () => {
    // A 404 here is the normal pre-send case. Sending with no threading header
    // still threads in the sender's Gmail via threadId; sending with a
    // fabricated one threads for nobody and looks like spoofing.
    threadsGet.mockRejectedValue(new Error("404 not found"));
    expect(await resolveFollowUpThreadHeaders("u1", "t1")).toEqual({});
  });
});
