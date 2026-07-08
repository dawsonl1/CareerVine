import { describe, it, expect } from "vitest";
import { markdownToHtml, looksLikeHtml } from "../lib/markdown.ts";

describe("looksLikeHtml", () => {
  it("detects HTML input", () => {
    expect(looksLikeHtml("<p>Hi there</p>")).toBe(true);
    expect(looksLikeHtml("  <div><b>x</b></div>")).toBe(true);
  });
  it("treats plain text and markdown as not-HTML", () => {
    expect(looksLikeHtml("Hi **there**")).toBe(false);
    expect(looksLikeHtml("a < b and b > c")).toBe(false);
  });
});

describe("markdownToHtml", () => {
  it("passes HTML through untouched", () => {
    const html = "<p>Hi <strong>Jane</strong></p>";
    expect(markdownToHtml(html)).toBe(html);
  });

  it("wraps paragraphs and converts single newlines to <br>", () => {
    expect(markdownToHtml("Hi Jane,\nGreat meeting you.\n\nBest,\nDawson")).toBe(
      "<p>Hi Jane,<br>Great meeting you.</p>\n<p>Best,<br>Dawson</p>",
    );
  });

  it("converts bold, italic, code, and links", () => {
    expect(markdownToHtml("**bold** and *ital* and `code`")).toBe(
      "<p><strong>bold</strong> and <em>ital</em> and <code>code</code></p>",
    );
    expect(markdownToHtml("see [my site](https://example.com/a?b=1)")).toBe(
      '<p>see <a href="https://example.com/a?b=1">my site</a></p>',
    );
  });

  it("keeps balanced parens inside a link URL", () => {
    expect(markdownToHtml("[docs](https://x.com/Foo_(bar)?q=1)")).toBe(
      '<p><a href="https://x.com/Foo_(bar)?q=1">docs</a></p>',
    );
  });

  it("converts bullet and numbered lists", () => {
    expect(markdownToHtml("- one\n- two")).toBe("<ul><li>one</li><li>two</li></ul>");
    expect(markdownToHtml("1. one\n2. two")).toBe("<ol><li>one</li><li>two</li></ol>");
  });

  it("escapes raw angle brackets and ampersands in markdown text", () => {
    expect(markdownToHtml("a < b & c > d")).toBe("<p>a &lt; b &amp; c &gt; d</p>");
  });

  it("leaves space-flanked asterisks (arithmetic, globs) as literal text", () => {
    // Regression: the italic rule must not wrap bare asterisks in <em>.
    expect(markdownToHtml("The cost is 2 * 3 and 4 * 5")).toBe(
      "<p>The cost is 2 * 3 and 4 * 5</p>",
    );
    expect(markdownToHtml("match *.ts and *.tsx files")).toBe(
      "<p>match *.ts and *.tsx files</p>",
    );
  });

  it("still applies real emphasis and keeps bold separate across blocks", () => {
    expect(markdownToHtml("**Update**\n\nRevenue *grew* 2x")).toBe(
      "<p><strong>Update</strong></p>\n<p>Revenue <em>grew</em> 2x</p>",
    );
  });
});
