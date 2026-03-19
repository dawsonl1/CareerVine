/**
 * Pure helper functions for Gmail email processing.
 * Extracted for testability.
 */

export type ParsedHeader = { name: string; value: string };

/** Find a header value by name (case-insensitive). */
export function getHeader(headers: ParsedHeader[], name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}

/** Extract a bare email address from a raw From/To header value. */
export function parseEmailAddress(raw: string): string {
  const match = raw.match(/<(.+?)>/);
  return (match ? match[1] : raw).toLowerCase().trim();
}
