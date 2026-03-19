/**
 * Shared helpers for contact search.
 * Extracted for testability.
 */

/**
 * Escape special PostgREST ilike characters so user input
 * is treated as literal text, not pattern syntax.
 * Unlike sanitizeForPostgrest (which strips chars), this *escapes* them.
 */
export function escapeIlikePattern(q: string): string {
  return q.replace(/[%_\\]/g, '\\$&');
}
