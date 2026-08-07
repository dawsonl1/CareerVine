import { describe, it, expect } from "vitest";

/**
 * CAR-262. `get_email_thread` returned the newest 10 messages with no offset, so
 * a long thread's opening message was unreachable through the MCP. It now takes
 * a window.
 *
 * This file MIRRORS that arithmetic rather than driving the handler, which is
 * weaker and worth saying out loud: the handler hydrates every message through
 * live Gmail calls, so exercising it means standing up a Gmail fake for a
 * question that is pure index math. The sibling
 * `src/mcp/__tests__/outreach-tools.test.ts` drives the real company/queue
 * handlers, because those have no such dependency and a mirror there would have
 * proved nothing — it was the first attempt at this ticket's tests, and the
 * coverage ratchet correctly rejected it.
 *
 * If `get_email_thread` grows a Gmail fake for another reason, move these.
 */

/** Mirrors the window computed in src/mcp/tools/email.ts get_email_thread. */
function threadWindow(total: number, limit = 10, beforeIndex?: number) {
  const end = Math.min(beforeIndex ?? total, total);
  const windowStart = Math.max(0, end - limit);
  return { windowStart, end, hasOlder: windowStart > 0, count: end - windowStart };
}

describe("get_email_thread windowing", () => {
  it("defaults to the newest 10 of a long thread", () => {
    expect(threadWindow(37)).toMatchObject({ windowStart: 27, end: 37, count: 10, hasOlder: true });
  });

  it("steps backwards through the thread with before_index", () => {
    const first = threadWindow(37);
    const second = threadWindow(37, 10, first.windowStart);
    const third = threadWindow(37, 10, second.windowStart);

    expect(second).toMatchObject({ windowStart: 17, end: 27, count: 10 });
    expect(third).toMatchObject({ windowStart: 7, end: 17, count: 10 });
    // Windows tile without gap or overlap, which is what makes paging back
    // through a whole thread actually reconstruct it rather than sample it.
    expect(second.end).toBe(first.windowStart);
    expect(third.end).toBe(second.windowStart);
  });

  it("reaches the very first message and then reports no more", () => {
    expect(threadWindow(37, 10, 7)).toMatchObject({ windowStart: 0, end: 7, count: 7, hasOlder: false });
  });

  it("never claims older messages exist on a short thread", () => {
    expect(threadWindow(4)).toMatchObject({ windowStart: 0, end: 4, count: 4, hasOlder: false });
  });

  it("clamps a before_index past the end rather than returning nothing", () => {
    expect(threadWindow(5, 10, 999)).toMatchObject({ windowStart: 0, end: 5, count: 5 });
  });
});
