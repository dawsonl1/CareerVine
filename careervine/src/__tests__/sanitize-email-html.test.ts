import { describe, it, expect } from "vitest";
import {
  sanitizeAiDraftHtml,
  sanitizeStoredEmailHtml,
} from "@/lib/ai/sanitize-email-html";

/** CAR-143 (R5.2 output half): both sanitization profiles. */

describe("sanitizeAiDraftHtml (tight AI-draft profile)", () => {
  it("keeps the allowlisted formatting tags and link attrs", () => {
    const html =
      '<p>Hi <strong>Sam</strong>, <em>read</em> <a href="https://x.com" target="_blank" rel="noopener">this</a><br><b>ok</b> <i>yes</i></p>';
    expect(sanitizeAiDraftHtml(html)).toBe(html);
  });

  it("strips script tags entirely", () => {
    expect(sanitizeAiDraftHtml('<p>hi</p><script>alert(1)</script>')).toBe("<p>hi</p>");
  });

  it("strips event handlers and non-allowlisted tags", () => {
    const out = sanitizeAiDraftHtml('<p onclick="x()">hi</p><img src=x onerror=alert(1)>');
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("onerror");
  });

  it("strips javascript: hrefs", () => {
    const out = sanitizeAiDraftHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain("javascript:");
  });

  it("drops headings but keeps lists (models emit them despite instructions)", () => {
    const out = sanitizeAiDraftHtml("<h1>Big</h1><ul><li>one</li><li>two</li></ul><p>ok</p>");
    expect(out).not.toContain("<h1>");
    // Without list tags, KEEP_CONTENT would flatten "one two" into "onetwo".
    expect(out).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(out).toContain("<p>ok</p>");
  });
});

describe("sanitizeStoredEmailHtml (broader email-safe profile)", () => {
  it("keeps normal email formatting like headings and lists", () => {
    const html = "<h2>Update</h2><ul><li>one</li></ul><p>hi</p>";
    expect(sanitizeStoredEmailHtml(html)).toBe(html);
  });

  it("strips script and style tags", () => {
    const out = sanitizeStoredEmailHtml(
      "<p>hi</p><script>fetch('https://evil')</script><style>p{display:none}</style>",
    );
    expect(out).toBe("<p>hi</p>");
  });

  it("strips event handlers", () => {
    const out = sanitizeStoredEmailHtml('<p onmouseover="steal()">hi</p>');
    expect(out).toBe("<p>hi</p>");
  });

  it("strips javascript: hrefs but keeps https links", () => {
    const out = sanitizeStoredEmailHtml(
      '<a href="javascript:alert(1)">bad</a> <a href="https://ok.com">good</a>',
    );
    expect(out).not.toContain("javascript:");
    expect(out).toContain('href="https://ok.com"');
  });

  it("strips form machinery and iframes", () => {
    const out = sanitizeStoredEmailHtml(
      '<form action="https://evil"><input name="pw"><button>go</button></form><iframe src="https://evil"></iframe><p>ok</p>',
    );
    expect(out).not.toContain("<form");
    expect(out).not.toContain("<input");
    expect(out).not.toContain("<button");
    expect(out).not.toContain("<iframe");
    expect(out).toContain("<p>ok</p>");
  });
});
