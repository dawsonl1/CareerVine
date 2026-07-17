import { describe, it, expect } from "vitest";

// CAR-148 — parity between the web app and the Chrome extension panel across the
// @panel alias (model: extension-rate-limit-copy.test.ts). These functions/maps
// are deliberately duplicated (the two projects share no bundle); the tests here
// fail the moment one side drifts from the other.

import { deriveContactStatus as webDeriveContactStatus } from "@/lib/profile-helpers";
import { deriveContactStatus as panelDeriveContactStatus } from "@panel/lib/profile-format";
import { AI_FAILURE_COPY as WEB_AI_COPY } from "@/lib/ai-errors";
import { AI_FAILURE_COPY as PANEL_AI_COPY } from "@panel/ai-failure";

// ── deriveContactStatus: web (profile-helpers) vs panel (profile-format) ──

describe("deriveContactStatus web/panel parity", () => {
  // Fixed clock so both sides evaluate the same cutoffs deterministically.
  const now = new Date(2026, 0, 15); // Jan 15, 2026

  const cases: { label: string; education: Array<{ end_year: string | null; is_current?: boolean }> }[] = [
    { label: "no education", education: [] },
    { label: "explicit Present", education: [{ end_year: "Present" }] },
    { label: "is_current flag", education: [{ end_year: null, is_current: true }] },
    { label: "future month+year", education: [{ end_year: "May 2027" }] },
    { label: "month+year already passed", education: [{ end_year: "Dec 2025" }] },
    { label: "year-only before July cutoff", education: [{ end_year: "2026" }] },
    { label: "year-only past", education: [{ end_year: "2025" }] },
    { label: "graduated years ago", education: [{ end_year: "2020" }] },
    { label: "latest of several wins", education: [{ end_year: "2024" }, { end_year: "2028" }] },
    { label: "unparseable end_year", education: [{ end_year: "sometime" }] },
  ];

  for (const { label, education } of cases) {
    it(`agrees for: ${label}`, () => {
      const web = webDeriveContactStatus(education, now);
      const panel = panelDeriveContactStatus(education, now);
      expect(panel).toEqual(web);
    });
  }

  it("both classify a current student as student", () => {
    const out = webDeriveContactStatus([{ end_year: "2027" }], now);
    expect(out).toEqual({ contact_status: "student", expected_graduation: "2027" });
    expect(panelDeriveContactStatus([{ end_year: "2027" }], now)).toEqual(out);
  });
});

// ── AI_FAILURE_COPY: web (ai-errors) vs panel (ai-failure) ────────────────
// The web map carries extra fields (ctaHref, serverMessage) the panel doesn't
// need, and the ai_trial_expired CTA is intentionally surface-specific (the
// panel links out to Settings; the web app requests access inline). Everything
// else must stay identical, so drift in the shared copy turns this red.

describe("AI_FAILURE_COPY web/panel parity", () => {
  it("defines exactly the same failure codes", () => {
    expect(Object.keys(PANEL_AI_COPY).sort()).toEqual(Object.keys(WEB_AI_COPY).sort());
  });

  it("keeps title and retryable identical for every code", () => {
    for (const code of Object.keys(WEB_AI_COPY) as (keyof typeof WEB_AI_COPY)[]) {
      expect(PANEL_AI_COPY[code].title).toBe(WEB_AI_COPY[code].title);
      expect(PANEL_AI_COPY[code].retryable).toBe(WEB_AI_COPY[code].retryable);
    }
  });

  it("keeps body and ctaLabel identical, except the surface-specific trial-expired CTA", () => {
    for (const code of Object.keys(WEB_AI_COPY) as (keyof typeof WEB_AI_COPY)[]) {
      if (code === "ai_trial_expired") continue; // panel links to Settings; web requests inline
      expect(PANEL_AI_COPY[code].body).toBe(WEB_AI_COPY[code].body);
      expect(PANEL_AI_COPY[code].ctaLabel).toBe(WEB_AI_COPY[code].ctaLabel);
    }
  });
});
