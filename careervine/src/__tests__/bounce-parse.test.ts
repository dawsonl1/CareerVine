import { describe, it, expect } from "vitest";
import {
  extractFailedRecipients,
  parseDeliveryStatus,
  needsFullFetch,
  subjectIndicatesDelay,
} from "@/lib/bounce-parse";

/**
 * CAR-217. Marking an address bounced is destructive: it 422s every future send,
 * retires the follow-up sequence and cancels queued scheduled mail. So these
 * tests are weighted toward the FALSE POSITIVE cases (a delay must never be read
 * as a failure) rather than only proving the happy path extracts an address.
 */

const header = (name: string, value: string) => ({ name, value });

/** A realistic Gmail-style DSN part for one permanently-failed recipient. */
function dsn(recipient: string, action: string, status: string): string {
  return [
    "Reporting-MTA: dns; googlemail.com",
    "",
    `Final-Recipient: rfc822; ${recipient}`,
    `Action: ${action}`,
    `Status: ${status}`,
    "Diagnostic-Code: smtp; 550 5.1.1 The email account does not exist.",
    "",
  ].join("\n");
}

describe("subjectIndicatesDelay", () => {
  it.each([
    ["Delivery Status Notification (Delay)", true],
    ["Delivery incomplete, message delayed", true],
    ["Warning: message is delaying", true],
    ["Delivery Status Notification (Failure)", false],
    ["Undeliverable: Coffee chat", false],
    ["", false],
  ])("%s -> %s", (subject, expected) => {
    expect(subjectIndicatesDelay(subject)).toBe(expected);
  });
});

describe("parseDeliveryStatus", () => {
  it("extracts a permanently failed recipient", () => {
    expect(parseDeliveryStatus(dsn("dead@corp.com", "failed", "5.1.1"))).toEqual({
      addresses: ["dead@corp.com"],
    });
  });

  it("treats a delayed recipient as NOT bounced", () => {
    // The whole point: Gmail is still retrying, and the address is fine.
    expect(parseDeliveryStatus(dsn("slow@corp.com", "delayed", "4.4.1"))).toEqual({
      addresses: [],
      skipped: "delayed",
    });
  });

  it("falls back to Status when Action is absent", () => {
    const body = ["Final-Recipient: rfc822; dead@corp.com", "Status: 5.0.0", ""].join("\n");
    expect(parseDeliveryStatus(body).addresses).toEqual(["dead@corp.com"]);
  });

  it("falls back to Action when Status is absent", () => {
    const body = ["Final-Recipient: rfc822; dead@corp.com", "Action: failed", ""].join("\n");
    expect(parseDeliveryStatus(body).addresses).toEqual(["dead@corp.com"]);
  });

  it("refuses to guess when Action and Status contradict each other", () => {
    // `failed` with a TRANSIENT 4.x.x status. Neither field is trustworthy on
    // its own here, and the safe reading of an unresolved pair is "not dead".
    const body = ["Final-Recipient: rfc822; unsure@corp.com", "Action: failed", "Status: 4.2.2", ""].join("\n");
    expect(parseDeliveryStatus(body)).toEqual({ addresses: [], skipped: "delayed" });
  });

  it("handles several recipients in one report, keeping only the failures", () => {
    const body = [
      "Reporting-MTA: dns; googlemail.com",
      "",
      "Final-Recipient: rfc822; dead@corp.com",
      "Action: failed",
      "Status: 5.1.1",
      "",
      "Final-Recipient: rfc822; slow@corp.com",
      "Action: delayed",
      "Status: 4.4.1",
      "",
      "Final-Recipient: rfc822; gone@corp.com",
      "Action: failed",
      "Status: 5.2.1",
      "",
    ].join("\n");
    expect(parseDeliveryStatus(body).addresses).toEqual(["dead@corp.com", "gone@corp.com"]);
  });

  it("strips the address-type prefix, angle brackets and case", () => {
    const body = ["Final-Recipient: RFC822; <John.Doe@Corp.COM>", "Action: failed", ""].join("\n");
    expect(parseDeliveryStatus(body).addresses).toEqual(["john.doe@corp.com"]);
  });

  it("unfolds a wrapped Final-Recipient line", () => {
    // RFC 5322 folding: a leading space continues the previous line. Without
    // unfolding, the address is truncated and matches no contact.
    const body = ["Final-Recipient: rfc822;", "  dead@corp.com", "Action: failed", ""].join("\n");
    expect(parseDeliveryStatus(body).addresses).toEqual(["dead@corp.com"]);
  });

  it("accepts CRLF line endings", () => {
    const body = "Final-Recipient: rfc822; dead@corp.com\r\nAction: failed\r\nStatus: 5.1.1\r\n\r\n";
    expect(parseDeliveryStatus(body).addresses).toEqual(["dead@corp.com"]);
  });

  it("reports no_recipients rather than delayed on an unparseable report", () => {
    expect(parseDeliveryStatus("Reporting-MTA: dns; googlemail.com\n")).toEqual({
      addresses: [],
      skipped: "no_recipients",
    });
  });

  it("resolves the LAST recipient group even without a trailing blank line", () => {
    const body = ["Final-Recipient: rfc822; dead@corp.com", "Action: failed", "Status: 5.1.1"].join("\n");
    expect(parseDeliveryStatus(body).addresses).toEqual(["dead@corp.com"]);
  });
});

describe("extractFailedRecipients — header path", () => {
  it("reads X-Failed-Recipients on a Failure notice", () => {
    const verdict = extractFailedRecipients({
      headers: [
        header("Subject", "Delivery Status Notification (Failure)"),
        header("X-Failed-Recipients", "Dead@Corp.com"),
      ],
    });
    expect(verdict.addresses).toEqual(["dead@corp.com"]);
  });

  it("splits a multi-address header", () => {
    const verdict = extractFailedRecipients({
      headers: [
        header("Subject", "Delivery Status Notification (Failure)"),
        header("X-Failed-Recipients", "a@corp.com, b@corp.com"),
      ],
    });
    expect(verdict.addresses).toEqual(["a@corp.com", "b@corp.com"]);
  });

  it("REFUSES the header when the subject says the message is only delayed", () => {
    // The regression this exists for. Gmail sends delay notices from the same
    // mailer-daemon address carrying the same header; acting on one kills a live
    // address and cancels a sequence that should still be running.
    const verdict = extractFailedRecipients({
      headers: [
        header("Subject", "Delivery Status Notification (Delay)"),
        header("X-Failed-Recipients", "alive@corp.com"),
      ],
    });
    expect(verdict).toEqual({ addresses: [], skipped: "delayed" });
  });

  it("still trusts the header when the subject is uninformative", () => {
    // Deliberately preserves pre-CAR-217 behavior: only the RECOGNIZED delay is
    // subtracted, so no bounce the old code caught is lost.
    const verdict = extractFailedRecipients({
      headers: [header("X-Failed-Recipients", "dead@corp.com")],
    });
    expect(verdict.addresses).toEqual(["dead@corp.com"]);
  });
});

describe("extractFailedRecipients — delivery-status path", () => {
  const payload = (body: string, mimeType = "message/delivery-status") => ({
    mimeType: "multipart/report",
    parts: [
      { mimeType: "text/plain", body: { data: Buffer.from("Delivery failed").toString("base64url") } },
      { mimeType, body: { data: Buffer.from(body).toString("base64url") } },
    ],
  });

  it("finds the address when there is NO X-Failed-Recipients header at all", () => {
    // The Microsoft 365 shape: an NDR generated by the recipient's own MTA.
    // These matched the search query and yielded nothing before CAR-217.
    const verdict = extractFailedRecipients({
      headers: [header("Subject", "Undeliverable: Coffee chat")],
      payload: payload(dsn("dead@corp.com", "failed", "5.1.10")),
    });
    expect(verdict.addresses).toEqual(["dead@corp.com"]);
  });

  it("finds a delivery-status part nested several levels down", () => {
    const verdict = extractFailedRecipients({
      headers: [],
      payload: {
        mimeType: "multipart/mixed",
        parts: [{ mimeType: "multipart/report", parts: payload(dsn("deep@corp.com", "failed", "5.1.1")).parts }],
      },
    });
    expect(verdict.addresses).toEqual(["deep@corp.com"]);
  });

  it("OVERRIDES a bounce-looking header when the report says delayed", () => {
    // Precedence matters: the part carries a per-recipient Action and the header
    // cannot, so a header-first reading would mark a live address on every
    // delay notice that happens to carry both.
    const verdict = extractFailedRecipients({
      headers: [header("X-Failed-Recipients", "alive@corp.com")],
      payload: payload(dsn("alive@corp.com", "delayed", "4.4.1")),
    });
    expect(verdict).toEqual({ addresses: [], skipped: "delayed" });
  });

  it("falls back to the header when the payload has no delivery-status part", () => {
    const verdict = extractFailedRecipients({
      headers: [
        header("Subject", "Delivery Status Notification (Failure)"),
        header("X-Failed-Recipients", "dead@corp.com"),
      ],
      payload: payload("irrelevant", "text/html"),
    });
    expect(verdict.addresses).toEqual(["dead@corp.com"]);
  });

  it("yields nothing when neither source resolves an address", () => {
    expect(extractFailedRecipients({ headers: [], payload: payload("", "text/html") })).toEqual({
      addresses: [],
      skipped: "no_recipients",
    });
  });
});

describe("needsFullFetch", () => {
  it("is false when the cheap metadata pass already has the header", () => {
    expect(needsFullFetch([header("X-Failed-Recipients", "a@b.com")])).toBe(false);
  });

  it("is true when it does not, so the caller re-fetches for the report part", () => {
    expect(needsFullFetch([header("Subject", "Undeliverable: hello")])).toBe(true);
  });
});
