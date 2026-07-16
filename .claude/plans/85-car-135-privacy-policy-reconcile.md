# CAR-135 — Reconcile privacy policy with actual data practices

**Type:** Compliance-accuracy copy fix (privacy policy). No schema, no new domain. Single-file copy change unless the R4.4 decision expands scope (see Open Decision).

**Source:** CAR-28 re-audit (2026-07-16), findings R4.1 (high), R4.2, R4.4, R4.8.

## What the code actually does (verified)

1. **Outbound email bodies are stored.** `sendTrackedEmail()` upserts `body_html` into `email_messages` (`careervine/src/lib/email-send.ts:120`), covering every outbound path (interactive send, MCP `send_email`, scheduled-email cron, follow-up cron). Full bodies are also stored for scheduled emails, drafts, and follow-up sequence steps. **Inbound** Gmail is snippet-only (CAR-115 migration is outbound-only). So `privacy/page.tsx:38` ("We do not store the full content of your emails on our servers") is false for everything the user sends.

2. **Server-side LinkedIn scraping via Apify — three surfaces, all undisclosed:**
   - Per-contact profile re-scrape on save/refresh (`harvestapi/linkedin-profile-scraper`).
   - Automatic **paid** email-address finder ($10/1k, SMTP-verified) that fires on enrich-on-save when a contact has no email, and on company-change events (`scrape-service.ts:274-288`, `:423-429`).
   - Discovery/prospect feed harvesting full public profiles of **non-contacts** (`harvestapi/linkedin-profile-search`) into `discovery_candidates` (full `raw` payload); curated "bundle" lists carry scraped emails in `bundle_prospects.payload`.

3. **Retention (R4.8):** `discovery_candidates.raw` and `bundle_prospects.payload` retain full third-party payloads indefinitely; dismissal keeps the row. No TTL / purge cron.

4. **Deletion (R4.4):** R2 contact/bundle photos on the public CDN (`assets.careervine.app`) are never deleted on contact-delete or account-delete and are outside every sweep (`storage-sweep.ts` only touches Supabase `attachments` + `application-files`). Contradicts the "delete all associated data" promise (`privacy/page.tsx:117`).

## Plan (copy changes to `careervine/src/app/privacy/page.tsx`)

- **Bump `lastUpdated`** to the ship date.
- **Section 2 — Google Account Data:** scope the no-storage claim to *inbound* mail (metadata + snippet only), remove the false blanket claim.
- **Section 2 — new "Emails You Send Through CareerVine":** disclose that full subject + body of sent/scheduled/draft/follow-up messages are stored, why (re-read, manage scheduled/drafts/follow-ups), and retention (until account deletion).
- **Section 2 — new "Contact Enrichment & Prospect Discovery (LinkedIn)":** disclose server-side Apify scraping: per-contact enrichment, automatic paid email lookup, and harvesting of non-contact profiles for discovery suggestions + curated lists. Public info only; spend-capped.
- **Section 3 — How We Use:** add enrichment/discovery bullet.
- **Section 4 — Third-Party Services:** add **Apify** entry.
- **Retention / deletion language:** disclose indefinite retention of scraped suggestion payloads (R4.8) honestly; resolve the deletion-promise vs R4.4 gap per Open Decision.
- Rule 35: no em dashes in the copy. Rule 34: docs page makes no contradicting claim (scraping is already a disclosed feature there), so no docs change expected — reconfirm before PR.

## Open Decision (surface to Dawson)

The account-deletion promise vs R4.4 (R2 photos survive deletion). Options:
- **A (recommended):** Fix R4.4 in this PR (delete R2 photos on account + contact deletion) so "delete all your data" stays literally true; keep the strong promise.
- **B:** Copy-only; soften the deletion copy to admit publicly-sourced photos may persist on the CDN; file R4.4 separately.
- **C:** Copy-only; keep the promise, file R4.4 as an urgent follow-up.

**R4.8** (TTL/purge for scraped payloads) and, if not chosen above, **R4.4**, get filed as separate behavior tickets.

## Verification

- `npm run test` from `careervine/`.
- If R4.4 fix is included: add coverage for R2 photo deletion on account/contact delete; exercise the deletion path.
- Copy review by Dawson before PR (public compliance document).
