import { describe, it, expect } from "vitest";
import { markdownToHtml } from "../lib/markdown";
import { sanitizeStoredEmailHtml } from "@/lib/ai/sanitize-email-html";

/**
 * CAR-143 (R5.2): MCP email bodies come straight from an LLM, and
 * markdownToHtml passes raw HTML through untouched — every MCP tool body must
 * therefore run through sanitizeStoredEmailHtml before storage/send. This
 * pins the composed invariant the email tools rely on.
 */
const toSafeEmailHtml = (body: string) => sanitizeStoredEmailHtml(markdownToHtml(body));

describe("MCP email body sanitization (markdownToHtml → stored profile)", () => {
  it("strips script/handlers/javascript: from raw-HTML bodies that bypass markdown escaping", () => {
    const out = toSafeEmailHtml(
      '<p>Hi</p><script>fetch("https://evil")</script><p onclick="x()">there</p><a href="javascript:alert(1)">l</a>',
    );
    expect(out).not.toContain("<script");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("javascript:");
    expect(out).toContain("<p>Hi</p>");
  });

  it("preserves everything the markdown converter legitimately emits", () => {
    const out = toSafeEmailHtml(
      "Hello **bold** *em* `code` [link](https://x.com/a)\n\n- one\n- two\n\n1. first\n2. second",
    );
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>em</em>");
    expect(out).toContain("<code>code</code>");
    expect(out).toContain('<a href="https://x.com/a">link</a>');
    expect(out).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(out).toContain("<ol><li>first</li><li>second</li></ol>");
  });
});
