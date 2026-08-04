import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderBounceAlert, describeCancellations, type BounceAlertItem } from "@/lib/notify/bounce-alert";
import { bounceAlertIdempotencyKey } from "@/lib/notify/send-bounce-alert";
import {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  NOTIFICATION_PURPOSES,
  NOTIFICATION_PREFERENCE_COLUMN,
} from "@/lib/notify/tokens";

/** CAR-217: the bounce alert's copy, escaping, and the token plumbing behind
 *  its one-click unsubscribe. Pure functions only — delivery is mocked at the
 *  detectBounces seam (see detect-bounces.test.ts). */

const APP = "https://www.careervine.app";
const UNSUB = "https://www.careervine.app/api/notifications/unsubscribe?token=t";

const item = (over: Partial<BounceAlertItem> = {}): BounceAlertItem => ({
  contactName: "Dana Reed",
  address: "dana@corp.com",
  contactId: 7,
  cancelledFollowUps: 0,
  cancelledScheduled: 0,
  ...over,
});

describe("describeCancellations", () => {
  it.each([
    [0, 0, ""],
    [1, 0, "1 follow-up"],
    [2, 0, "2 follow-ups"],
    [0, 1, "1 scheduled email"],
    [0, 3, "3 scheduled emails"],
    [2, 1, "2 follow-ups and 1 scheduled email"],
  ])("(%i, %i) -> %s", (followUps, scheduled, expected) => {
    expect(describeCancellations(followUps, scheduled)).toBe(expected);
  });
});

describe("renderBounceAlert", () => {
  it("names the contact in the subject for a single bounce", () => {
    const { subject } = renderBounceAlert([item()], APP, UNSUB);
    expect(subject).toBe("Your email to Dana Reed could not be delivered");
  });

  it("counts them in the subject for several", () => {
    const { subject } = renderBounceAlert(
      [item(), item({ contactName: "Sam Vale", address: "sam@corp.com" })],
      APP,
      UNSUB,
    );
    expect(subject).toBe("2 contact addresses stopped accepting mail");
  });

  it("says what was cancelled, in both HTML and text", () => {
    const { html, text } = renderBounceAlert(
      [item({ cancelledFollowUps: 2, cancelledScheduled: 1 })],
      APP,
      UNSUB,
    );
    expect(html).toContain("Cancelled 2 follow-ups and 1 scheduled email.");
    expect(text).toContain("Cancelled 2 follow-ups and 1 scheduled email.");
  });

  it("omits the cancellation line entirely when nothing was queued", () => {
    // Rather than printing "Cancelled 0 things", which reads as a malfunction.
    const { html, text } = renderBounceAlert([item()], APP, UNSUB);
    expect(html).not.toContain("Cancelled");
    expect(text).not.toContain("Cancelled");
  });

  it("deep-links to the contact when there is one, and to the list when there is not", () => {
    expect(renderBounceAlert([item()], APP, UNSUB).html).toContain(`${APP}/contacts/7`);
    expect(renderBounceAlert([item({ contactId: null })], APP, UNSUB).html).toContain(`${APP}/contacts"`);
  });

  it("escapes HTML in the contact name and address", () => {
    const { html } = renderBounceAlert(
      [item({ contactName: '<script>alert("x")</script>', address: "a&b@corp.com" })],
      APP,
      UNSUB,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("a&amp;b@corp.com");
  });

  it("carries the unsubscribe link", () => {
    const { html, text } = renderBounceAlert([item()], APP, UNSUB);
    expect(html).toContain(UNSUB);
    expect(text).toContain(UNSUB);
  });

  it("uses no em dashes anywhere the user reads (rule 35)", () => {
    const { subject, html, text } = renderBounceAlert(
      [item({ cancelledFollowUps: 1, cancelledScheduled: 2 })],
      APP,
      UNSUB,
    );
    for (const copy of [subject, html, text]) expect(copy).not.toContain("—");
  });
});

describe("bounceAlertIdempotencyKey", () => {
  const NOW = "2026-08-04T17:00:00.000Z";

  it("is stable across a retry of the same discovery", () => {
    expect(bounceAlertIdempotencyKey("u1", ["a@x.com", "b@x.com"], NOW)).toBe(
      bounceAlertIdempotencyKey("u1", ["a@x.com", "b@x.com"], "2026-08-04T23:59:00.000Z"),
    );
  });

  it("does not depend on detection ORDER", () => {
    expect(bounceAlertIdempotencyKey("u1", ["b@x.com", "a@x.com"], NOW)).toBe(
      bounceAlertIdempotencyKey("u1", ["a@x.com", "b@x.com"], NOW),
    );
  });

  it("differs across users, address sets, and days", () => {
    const base = bounceAlertIdempotencyKey("u1", ["a@x.com"], NOW);
    expect(bounceAlertIdempotencyKey("u2", ["a@x.com"], NOW)).not.toBe(base);
    expect(bounceAlertIdempotencyKey("u1", ["c@x.com"], NOW)).not.toBe(base);
    expect(bounceAlertIdempotencyKey("u1", ["a@x.com"], "2026-08-05T00:00:00.000Z")).not.toBe(base);
  });
});

describe("unsubscribe tokens carry the purpose", () => {
  const OLD = process.env.NUDGE_UNSUBSCRIBE_SECRET;
  beforeEach(() => {
    process.env.NUDGE_UNSUBSCRIBE_SECRET = "test-secret";
  });
  afterEach(() => {
    if (OLD === undefined) delete process.env.NUDGE_UNSUBSCRIBE_SECRET;
    else process.env.NUDGE_UNSUBSCRIBE_SECRET = OLD;
  });

  it("round-trips every purpose", () => {
    for (const purpose of NOTIFICATION_PURPOSES) {
      expect(verifyUnsubscribeToken(signUnsubscribeToken("u1", purpose))).toEqual({
        userId: "u1",
        purpose,
      });
    }
  });

  it("will not let one purpose's token pass as another's", () => {
    // The whole reason the purpose is INSIDE the signed payload: silencing
    // follow-up reminders must not silence undeliverable-mail alerts.
    const token = signUnsubscribeToken("u1", "followup_nudges");
    const swapped = token.replace("followup_nudges", "bounce_alerts");
    expect(verifyUnsubscribeToken(swapped)).toBeNull();
  });

  it("rejects a purpose that maps to no preference column", () => {
    const token = signUnsubscribeToken("u1", "bounce_alerts");
    expect(verifyUnsubscribeToken(token.replace("bounce_alerts", "drop_table"))).toBeNull();
  });

  it("every purpose has a preference column", () => {
    for (const purpose of NOTIFICATION_PURPOSES) {
      expect(NOTIFICATION_PREFERENCE_COLUMN[purpose]).toBeTruthy();
    }
  });

  it("still fails closed when the secret is unset", () => {
    const token = signUnsubscribeToken("u1", "bounce_alerts");
    delete process.env.NUDGE_UNSUBSCRIBE_SECRET;
    expect(verifyUnsubscribeToken(token)).toBeNull();
  });
});

describe("no stray mocks", () => {
  it("this file exercises the real modules", () => {
    expect(vi.isMockFunction(renderBounceAlert)).toBe(false);
  });
});
