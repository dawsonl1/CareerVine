/**
 * LinkedIn URL canonicalization.
 *
 * The contacts table dedupes on exact linkedin_url string equality —
 * trailing slashes, www variants, uppercase hosts, and query strings would
 * otherwise create duplicate contacts. Since CAR-155 this invariant is
 * enforced at the write chokepoint: createContact/updateContact in
 * src/lib/data/contacts.ts run canonicalizeLinkedinUrl on every contacts
 * write, so no caller can skip it (guarded by the out-of-band-write scan in
 * src/__tests__/contact-write-chokepoint.test.ts). Read-side callers
 * (dedupe probes, scrape matching) still canonicalize before comparing.
 *
 * Canonical form: https://www.linkedin.com/in/<slug>
 */

/**
 * Internal (non-vanity) LinkedIn member ids look like "ACoAAABeT88..." /
 * "ACwAAA...". They appear when a scrape saw a profile the actor couldn't
 * resolve to a vanity slug. They are case-SENSITIVE — never lowercase them.
 */
export function isInternalLinkedinId(slug: string): boolean {
  return /^AC[ow]AA/.test(slug);
}

/**
 * Canonicalize a LinkedIn profile URL.
 * Returns null when the input is not a LinkedIn profile URL.
 */
export function canonicalizeLinkedinUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let raw = url.trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;

  const match = parsed.pathname.match(/\/in\/([^/]+)/i);
  if (!match) return null;

  let slug = match[1];
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // Malformed percent-encoding — keep the raw slug
  }
  slug = slug.replace(/\/+$/, "").trim();
  if (!slug) return null;
  if (!isInternalLinkedinId(slug)) slug = slug.toLowerCase();

  return `https://www.linkedin.com/in/${slug}`;
}

/**
 * Extract the vanity public identifier (profile slug) from a LinkedIn URL.
 * Returns null for internal-id URLs — those are not stable public
 * identifiers and must not be used as a dedupe key.
 */
export function extractPublicIdentifier(url: string | null | undefined): string | null {
  const canonical = canonicalizeLinkedinUrl(url);
  if (!canonical) return null;
  const slug = canonical.slice(canonical.lastIndexOf("/") + 1);
  return isInternalLinkedinId(slug) ? null : slug;
}

/**
 * Extract the company slug from a LinkedIn company URL
 * (e.g. https://www.linkedin.com/company/google/ → "google").
 * Numeric-only slugs are internal ids, not universal names — returns null.
 */
export function extractCompanyUniversalName(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = url.match(/linkedin\.com\/company\/([^/?#]+)/i);
  if (!match) return null;
  const slug = decodeURIComponentSafe(match[1]).replace(/\/+$/, "").toLowerCase();
  if (!slug || /^\d+$/.test(slug)) return null;
  return slug;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
