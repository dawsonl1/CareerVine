/**
 * Minimal markdown → email-safe HTML.
 *
 * Tool body inputs accept markdown (what Claude naturally writes) or
 * raw HTML. HTML passes through untouched; markdown is escaped first,
 * then a conservative subset is transformed: paragraphs, line breaks,
 * bold, italic, inline code, links, and bullet/numbered lists. No
 * headings/blockquotes — this is email, not a document.
 */

/** Heuristic: treat input as HTML if it opens with a tag and contains a closing tag. */
export function looksLikeHtml(input: string): boolean {
  const trimmed = input.trim();
  return /^</.test(trimmed) && /<\/[a-z][^>]*>/i.test(trimmed);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Bold, italic, inline code, links — applied to already-escaped text. */
function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    // Emphasis delimiters must hug non-space (CommonMark rule), so bare
    // asterisks in prose — "2 * 3", globs — aren't turned into <em>.
    .replace(/(^|[^*])\*([^\s*][^*\n]*?[^\s*]|[^\s*])\*/g, "$1<em>$2</em>")
    // Allow one level of balanced parens in the URL so links like
    // …/Foo_(bar)?q=1 aren't truncated at the first ")".
    .replace(
      /\[([^\]]+)\]\((https?:\/\/(?:[^\s()]+|\([^\s()]*\))*)\)/g,
      '<a href="$2">$1</a>',
    );
}

export function markdownToHtml(input: string): string {
  if (looksLikeHtml(input)) return input;

  const blocks = input.replace(/\r\n/g, "\n").trim().split(/\n{2,}/);
  const html: string[] = [];

  for (const block of blocks) {
    const lines = block.split("\n");
    const isBullet = lines.every((l) => /^\s*[-*]\s+/.test(l));
    const isNumbered = lines.every((l) => /^\s*\d+[.)]\s+/.test(l));

    if (isBullet || isNumbered) {
      const tag = isBullet ? "ul" : "ol";
      const items = lines
        .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, ""))
        .map((l) => `<li>${inline(escapeHtml(l))}</li>`)
        .join("");
      html.push(`<${tag}>${items}</${tag}>`);
    } else {
      const body = lines.map((l) => inline(escapeHtml(l))).join("<br>");
      html.push(`<p>${body}</p>`);
    }
  }

  return html.join("\n");
}
