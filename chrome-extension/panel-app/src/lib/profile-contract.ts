// The single source of truth for the LinkedIn profile payload shape shared by
// the Chrome extension panel and the CareerVine web app. Pure TypeScript — no
// zod, no React, no chrome APIs — so it crosses the @panel alias into the web
// app's typecheck AND stays importable by the panel's standalone vite build
// (which has no zod dependency).
//
// The web app derives its real zod validator from these types in
// `careervine/src/lib/extension-contract.ts`; a parity test there asserts the
// inferred schema type stays byte-for-byte equal to `ProfileData`, so a rename
// on either side turns CI red. This is the ONLY `ProfileData` declaration in
// the repo (CAR-148 / F11) — every other site imports it.
//
// Fields the wire schema fills with a default (`location`, `experience`,
// `education`, `suggested_tags`, `contact_status`) are non-optional here because
// after parsing (server) or `enrichProfile` (panel) they are always present;
// everything else is optional because payloads legitimately omit it.

export interface ProfileLocation {
  city?: string | null;
  state?: string | null;
  country?: string | null;
}

export interface ProfileExperience {
  /** Panel-local React key; ignored server-side. */
  id?: string;
  company?: string;
  title?: string | null;
  location?: string | null;
  workplace_type?: string | null;
  start_month?: string | null;
  end_month?: string | null;
  is_current?: boolean;
}

export interface ProfileEducation {
  /** Panel-local React key; ignored server-side. */
  id?: string;
  school?: string;
  degree?: string | null;
  field_of_study?: string | null;
  start_year?: string | null;
  end_year?: string | null;
  is_current?: boolean;
}

export interface ProfileData {
  // ── Identity ─────────────────────────────────────────────────────────
  name?: string;
  first_name?: string | null;
  last_name?: string | null;
  linkedin_url?: string | null;
  /** Alternate URL key some payloads send; server canonicalizes both. */
  profileUrl?: string | null;
  industry?: string | null;
  headline?: string | null;
  about?: string | null;

  // ── Present after parse/enrich (schema defaults) ─────────────────────
  location: ProfileLocation;
  experience: ProfileExperience[];
  education: ProfileEducation[];
  suggested_tags: string[];
  contact_status: "student" | "professional" | null;

  // ── Optional metadata ────────────────────────────────────────────────
  tags?: string[];
  expected_graduation?: string | null;
  follow_up_frequency?: string | null;
  follow_up_frequency_days?: number | null;
  notes?: string | null;
  generated_notes?: string | null;
  email?: string | null;
  contactInfo?: { email?: string };
  photo_url?: string | null;
  current_company?: string | null;
}
