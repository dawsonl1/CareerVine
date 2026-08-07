import { describe, it, expect } from "vitest";

/**
 * CAR-262. Three of the MCP read tools capped their lists with no way past the
 * cap, so the data beyond it was unreachable through the server: person #51 at a
 * large company, the opening message of a long thread, the 16th neglected
 * contact. The windowing arithmetic behind those fixes is pure, so it is pinned
 * here rather than through the tool layer.
 *
 * The paging PROSE matters as much as the arithmetic: a bare count next to a
 * silently truncated list is exactly how an agent concludes it has seen
 * everything, which was the failure being fixed.
 */

/** Mirrors `pageNote` in src/mcp/tools/outreach.ts. */
function pageNote(total: number, start: number, shown: number): string {
  if (shown === 0) return total === 0 ? "" : ` — none on this page (offset ${start} of ${total})`;
  if (shown === total && start === 0) return "";
  return `; showing ${start + 1}-${start + shown}${start + shown < total ? ` (pass offset:${start + shown} for more)` : ""}`;
}

/** Mirrors the get_email_thread window in src/mcp/tools/email.ts. */
function threadWindow(total: number, limit = 10, beforeIndex?: number) {
  const end = Math.min(beforeIndex ?? total, total);
  const windowStart = Math.max(0, end - limit);
  return { windowStart, end, hasOlder: windowStart > 0, count: end - windowStart };
}

describe("pageNote", () => {
  it("says nothing when one page holds everything", () => {
    expect(pageNote(3, 0, 3)).toBe("");
    expect(pageNote(0, 0, 0)).toBe("");
  });

  it("states the window AND how to get the next one", () => {
    expect(pageNote(300, 0, 50)).toBe("; showing 1-50 (pass offset:50 for more)");
    expect(pageNote(300, 50, 50)).toBe("; showing 51-100 (pass offset:100 for more)");
  });

  it("stops offering a next page on the last one", () => {
    expect(pageNote(120, 100, 20)).toBe("; showing 101-120");
  });

  it("explains an empty page instead of looking like an empty result", () => {
    // The difference between "this company has nobody" and "you paged past the
    // end", which a bare empty array cannot express.
    expect(pageNote(40, 100, 0)).toBe(" — none on this page (offset 100 of 40)");
  });
});

describe("get_email_thread windowing", () => {
  it("defaults to the newest 10 of a long thread", () => {
    const w = threadWindow(37);
    expect(w).toMatchObject({ windowStart: 27, end: 37, count: 10, hasOlder: true });
  });

  it("steps backwards through the thread with before_index", () => {
    const first = threadWindow(37);
    const second = threadWindow(37, 10, first.windowStart);
    const third = threadWindow(37, 10, second.windowStart);

    expect(second).toMatchObject({ windowStart: 17, end: 27, count: 10 });
    expect(third).toMatchObject({ windowStart: 7, end: 17, count: 10 });
    // Windows tile without gaps or overlap, which is what makes paging back
    // through a whole thread actually reconstruct it.
    expect(second.end).toBe(first.windowStart);
    expect(third.end).toBe(second.windowStart);
  });

  it("reaches the very first message and then reports no more", () => {
    const w = threadWindow(37, 10, 7);
    expect(w).toMatchObject({ windowStart: 0, end: 7, count: 7, hasOlder: false });
  });

  it("never claims older messages exist on a short thread", () => {
    expect(threadWindow(4)).toMatchObject({ windowStart: 0, end: 4, count: 4, hasOlder: false });
  });

  it("clamps a before_index past the end rather than returning nothing", () => {
    expect(threadWindow(5, 10, 999)).toMatchObject({ windowStart: 0, end: 5, count: 5 });
  });
});
