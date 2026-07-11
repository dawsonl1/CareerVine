/**
 * Contact fingerprint primitives for the bundle touched-state machinery
 * (plan 29 §5). Split out of bundle-sync.ts so the fast-apply path (CAR-62)
 * can compute fingerprints without a runtime import cycle
 * (bundle-sync → bundle-fast-apply → bundle-sync). bundle-sync re-exports
 * these, so existing importers are unaffected.
 */

import { createHash } from "crypto";
import { stableStringify } from "./bundle-publish";

/** The user-editable surface the fingerprint covers. EXCLUDES everything
 * the importer writes outside the fingerprint-refresh window (photo_url,
 * last_scraped_at, provenance, scraped-source child rows) — those changing
 * must never read as user edits. */
export interface ContactFingerprintInput {
  name: string | null;
  headline: string | null;
  notes: string | null;
  persona: string | null;
  network_status: string | null;
  stage_override: string | null;
  /** employmentKey()s of contact_companies rows with source='manual'. */
  manual_employment_keys: string[];
  /** Addresses of contact_emails rows with source='manual'. */
  manual_emails: string[];
  /** All tag names on the contact. */
  tags: string[];
}

export function computeContactFingerprint(input: ContactFingerprintInput): string {
  const canonical = {
    name: input.name ?? null,
    headline: input.headline ?? null,
    notes: input.notes ?? null,
    persona: input.persona ?? null,
    network_status: input.network_status ?? null,
    stage_override: input.stage_override ?? null,
    manual_employment_keys: [...input.manual_employment_keys].sort(),
    manual_emails: [...input.manual_emails].map((e) => e.toLowerCase()).sort(),
    tags: [...input.tags].sort(),
  };
  return createHash("sha256").update(stableStringify(canonical)).digest("hex");
}

/** Tag names as addTagsToContacts persists them (trim + lowercase, deduped).
 * Every fingerprint computed from PAYLOAD tags (rather than a DB re-read)
 * must pass tags through this, or the baseline can never match a later
 * fetchTouchSignals read of the stored names (CAR-62 audit finding). */
export function normalizeTagNames(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
}
