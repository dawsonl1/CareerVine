/**
 * CAR-38 analytics: event registry, edit ratio, server tracker no-op and
 * mirror behavior, and milestone one-time semantics.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// service-client is imported by analytics/server — mock before importing it.
const insertMock = vi.fn();
const fromMock = vi.fn(() => ({ insert: insertMock }));
vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: () => ({ from: fromMock }),
}));

import { MIRRORED_EVENTS, MILESTONE_THRESHOLDS } from "@/lib/analytics/events";
import { editRatio } from "@/lib/analytics/edit-ratio";
import {
  trackServer,
  reachMilestone,
  _resetAnalyticsForTests,
} from "@/lib/analytics/server";

beforeEach(() => {
  _resetAnalyticsForTests();
  insertMock.mockReset().mockResolvedValue({ error: null });
  fromMock.mockClear();
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
});

describe("event registry", () => {
  it("mirrors exactly the business-critical outcome events", () => {
    expect([...MIRRORED_EVENTS].sort()).toEqual([
      "email_sent",
      "meeting_created",
      "reply_received",
    ]);
  });

  it("defines the new-user milestone thresholds from Dawson's metric list", () => {
    expect(MILESTONE_THRESHOLDS).toEqual({ contacts_5: 5, companies_emailed_5: 5 });
  });
});

describe("editRatio", () => {
  it("returns 1 for a verbatim send", () => {
    expect(editRatio("<p>Hi Sam, great to meet you</p>", "<p>Hi Sam, great to meet you</p>")).toBe(1);
  });

  it("returns 0 for a full rewrite", () => {
    expect(editRatio("<p>alpha beta gamma</p>", "<p>one two three</p>")).toBe(0);
  });

  it("scores partial edits between 0 and 1 and ignores markup", () => {
    const ratio = editRatio(
      "<p>Hi Sam, I loved our chat about product analytics</p>",
      "<div>Hi Sam, I loved our conversation about analytics tooling</div>",
    );
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(1);
  });

  it("handles empty inputs without dividing by zero", () => {
    expect(editRatio("", "")).toBe(1);
    expect(editRatio("<p>text</p>", "")).toBe(0);
  });
});

describe("trackServer", () => {
  it("does nothing without a user id", async () => {
    await trackServer(null, "email_sent", {});
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("mirrors outcome events to analytics_events even with PostHog unset", async () => {
    await trackServer("user-1", "email_sent", { is_follow_up: false });
    expect(fromMock).toHaveBeenCalledWith("analytics_events");
    expect(insertMock).toHaveBeenCalledWith({
      user_id: "user-1",
      event: "email_sent",
      surface: "server",
      properties: { is_follow_up: false },
    });
  });

  it("does not mirror behavioral (non-outcome) events", async () => {
    await trackServer("user-1", "compose_opened", { source: "blank" });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("never throws when the mirror insert fails", async () => {
    insertMock.mockRejectedValueOnce(new Error("db down"));
    await expect(trackServer("user-1", "reply_received", {})).resolves.toBeUndefined();
  });
});

describe("reachMilestone", () => {
  it("inserts the milestone and emits milestone_reached on first crossing", async () => {
    await reachMilestone("user-1", "contacts_5");
    expect(fromMock).toHaveBeenCalledWith("user_milestones");
    expect(insertMock).toHaveBeenCalledWith({ user_id: "user-1", milestone: "contacts_5" });
  });

  it("stays silent when the milestone was already reached (duplicate insert)", async () => {
    insertMock.mockResolvedValueOnce({ error: { code: "23505" } });
    await reachMilestone("user-1", "contacts_5");
    // Only the user_milestones insert — no milestone_reached mirror/event work.
    expect(fromMock).toHaveBeenCalledTimes(1);
  });
});
