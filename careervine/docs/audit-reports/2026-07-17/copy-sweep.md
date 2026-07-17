# User-Facing Copy Sweep (Task 5)

**Date:** 2026-07-17
**Scope:** Rendered user-facing copy in `careervine/src/app/**` and `careervine/src/components/**` (JSX text, headings, button labels, placeholders, aria-labels, toast/error/success messages), plus `careervine/public/docs/index.html`.
**Looked for:** typos, grammar errors, inconsistent product terminology, em dashes (—) in rendered copy (rule 35), broken internal anchor links in the docs page, and stale/incorrect product claims.

## Summary

The codebase copy is in very good shape. Automated sweeps found **zero** common misspellings, **zero** doubled words, **zero** `e-mail`/`GMail`/`Linkedin`-casing errors, and **no broken internal anchors** in the docs page (all 27 `href="#…"` targets resolve to a matching `id`). The privacy, terms, and landing-page prose are clean. Several product claims were spot-verified against source and are **accurate**: Next.js 16, exactly 27 MCP tools (names match the docs one-for-one), 24h free AI trial, 500 MB upload limit, 100/day Gmail send cap, and 100/hour MCP rate limit.

**8 findings** remain, none critical. The most important is **S1**: the OAuth consent screen hardcodes "Claude" in its title and two subtitles even though it supports ChatGPT / Codex / Cursor and already resolves the real client name into a variable it uses two lines away. The rest are a garbled docs sentence, a genuine product terminology split for one pipeline stage ("Outreach active" vs "Active outreach"), and minor accuracy/consistency nits.

On **em dashes**: no em dashes appear in rendered *prose* anywhere in `.tsx`, the docs page, or the cold-zone legal pages. The only em dashes in rendered output are standalone `"—"` empty-value placeholder glyphs (see **E1**), which are a typographic no-value convention rather than sentence punctuation. Every other em dash in the tree is inside code comments or LLM prompt strings (not user-facing).

---

## Typos

None found. (Grepped a ~60-word misspelling dictionary and a doubled-word heuristic across all `.tsx`/`.ts`/`.html` in scope; no hits.)

---

## Grammar

### G1 — Garbled / redundant sentence in the docs onboarding step
- **File:** `careervine/public/docs/index.html:603`
- **Current:** "The company list opens instantly, ranked by how many alumni you would know there **with alumni and product-role sub-counts**."
- **Problem:** "how many alumni you would know there with alumni … sub-counts" repeats "alumni" and reads as a run-on. The feature (per `onboarding-flow.tsx:685-695`) ranks by warmth and shows two stacked sub-counts: total BYU alumni, then how many hold product roles.
- **Suggested rewrite:** "The company list opens instantly, ranked by how many people you would know there, with total-alumni and product-role sub-counts."
- **Note:** Because the exact intended first noun ("alumni" vs "people you'd know") is a judgment call, this is reported only, not proposed as an auto-apply cold edit.

---

## Terminology

### T1 — Same pipeline stage rendered under two different labels (product, report-only)
The `outreach_active` company pipeline stage is labeled inconsistently on two user-facing surfaces:
- **`careervine/src/components/companies/company-filter-bar.tsx:19`** → `outreach_active: "Outreach active"` — rendered on the companies-list **filter chips** (`:100`) and on **company cards** (`company-card.tsx:96` and `:164`).
- **`careervine/src/components/companies/pipeline/pipeline-layout.tsx:52`** → `outreach_active: "Active outreach"` — rendered as the **pipeline stage-editor heading** (`:162`).
- **Impact:** A user sees "Outreach active" on the companies list and "Active outreach" inside a company's pipeline for the same stage. All other stages (Researching, Applied, Interviewing, Closed) match between the two maps; only this one diverges.
- **Fix:** Standardize on one label in both maps. (Neither file is in the cold zone, so no auto-edit proposed — this needs a product decision on which wording wins.)

### T2 — Docs describe the filter chip as "Outreach" (matches neither surface)
- **File:** `careervine/public/docs/index.html:791`
- **Current:** "Pipeline-stage chips (Researching, **Outreach**, Applied, Interviewing, Closed) are the primary filter"
- **Problem:** The actual chip label is **"Outreach active"** (see T1). The same docs page then calls the stage **"Active outreach"** at `:801`, so the page is internally inconsistent too.
- **Suggested rewrite:** change "Outreach" → "Outreach active" to match the rendered chip.
- **Proposed as a cold edit** (medium confidence — accurate to current chips; if T1 is resolved toward "Active outreach", update this line to match).

### T3 — In-app accepted-formats text omits two formats it actually accepts
- **File:** `careervine/src/components/transcript-uploader.tsx:206`
- **Current visible text:** ".mp3, .m4a, .wav, .mp4, .webm, .mov"
- **Problem:** `AUDIO_ACCEPT` at `:36` is `.mp3,.m4a,.wav,.ogg,.flac,.mp4,.webm,.mov` — the uploader accepts **`.ogg` and `.flac`** but the helper text under the drop zone doesn't list them. (The docs page at `:760` correctly lists all eight.)
- **Suggested rewrite:** ".mp3, .m4a, .wav, .ogg, .flac, .mp4, .webm, .mov" (or trim `AUDIO_ACCEPT` if ogg/flac are intentionally unsupported).

### T4 — Docs section eyebrow drops two supported clients (minor)
- **File:** `careervine/public/docs/index.html:826`
- **Current:** "27 tools for Claude, ChatGPT, Cursor and more"
- **Problem:** Everywhere else the client list is "Claude, the Claude Code CLI, ChatGPT, Codex, or Cursor" (`:503`, `:828`, `:913`, `mcp-connect-card.tsx:14-15`). The eyebrow omits Codex and the Claude Code CLI. Acceptable as an abbreviated label, flagged for consistency only.

### T5 — Nav label vs page heading (minor, expected abbreviation)
- **Files:** `careervine/src/components/navigation.tsx:43` (`label: "Actions"`) vs `careervine/src/app/action-items/page.tsx:466` (`<h1>Action Items</h1>`).
- The nav abbreviates "Action Items" to "Actions". This is a normal compact-nav pattern (same as `/meetings` → nav "Activity" → page "Activity", which *is* consistent). Reported only for completeness; no change recommended unless full label parity is desired.

---

## Em dashes (rule 35)

**No prose em dashes** were found in any rendered `.tsx`, the docs page, or the cold-zone legal pages. Every `—` in the source tree is one of: a JSX/JS/CSS comment, an LLM prompt string sent to OpenAI (`api/ai/*`, `api/transcripts/*` — never shown to users), or the empty-value glyph below.

### E1 — Standalone `"—"` empty-value placeholders (borderline; report-only)
Several components render a bare em dash as a "no value" indicator:
- `careervine/src/components/admin/account-section.tsx:35` — `{value || "—"}`
- `careervine/src/components/admin/contacts-section.tsx:336` — `.join(" · ") || "—"`
- `careervine/src/app/admin/users/page.tsx:327` — `{u.email ?? "—"}`
- `careervine/src/components/companies/person-modal.tsx:135` and `:154` — `{r.title ?? "—"}` / `{cc.title ?? "—"}`
- `careervine/src/components/companies/pipeline/researching-programs.tsx:70` — `placeholder="—"`
- `careervine/src/components/ui/applications-open-picker.tsx:461` and `:481` — `… : "—"`
- `careervine/src/components/settings/provider-key-card.tsx:64` — `if (!iso) return "—";`

**Assessment:** These are a typographic no-value convention, not sentence punctuation, so rule 35's "rewrite with a comma/colon/parentheses" remediation doesn't apply. They are a borderline case. If strict rule-35 compliance across *every* rendered glyph is desired, swap them for a hyphen `-`, an en dash `–`, or a short word like `Not set`. Left as report-only; none is in the cold zone.

---

## Broken internal links

None. Every internal anchor in `careervine/public/docs/index.html` (`#overview`, `#start`, `#next`, `#write`, `#followup`, `#remember`, `#pipeline`, `#assistant`, `#trust`, plus all `#g-*`, `#ov-*`, and `#t-*` group/tab targets — 27 distinct `href="#…"`) resolves to a matching element `id`. The tab panels (`#t-web`, `#t-engine`, `#t-ext`, `#t-mcp`) and overview block headings (`#ov-where`, `#ov-does`, `#ov-want`, `#ov-next`) all have their ids present.

---

## Stale / incorrect product claims

### S1 — OAuth consent screen hardcodes "Claude" but supports (and knows) other clients
- **File:** `careervine/src/app/oauth/consent/page.tsx`
- **Lines / current text:**
  - `:105` — `subtitle="Claude needs your approval to connect to CareerVine."` (shown in the not-signed-in state)
  - `:152` — `title="Connect Claude to CareerVine"`
  - `:164` — `<p>You can disconnect anytime from Claude&apos;s connector settings.</p>`
- **Problem:** The MCP server is documented and built for multiple clients — "Claude, the Claude Code CLI, ChatGPT, Codex, or Cursor" (docs `:503`, `:828`; `mcp-connect-card.tsx`). This very page already resolves the real requesting client into `clientName` (`:148`) and uses it correctly in the signed-in subtitle (`:153`) and the permission bullets (`:160`). But the page **title**, the **not-signed-in subtitle**, and the **disconnect hint** hardcode "Claude", so a user connecting via ChatGPT/Cursor/Codex sees "Connect Claude to CareerVine". This also contradicts the docs' own claim that "A consent screen **names the requesting client**" (`:890`).
- **Fixes (cold zone — proposed):**
  - `:152` → use the already-available `clientName`: `title={`Connect ${clientName} to CareerVine`}`.
  - `:164` → generic, correct for any client: "You can disconnect anytime from your AI client's connector settings."
  - `:105` → `clientName` is not yet loaded pre-sign-in, so use a generic: "An app needs your approval to connect to CareerVine."

### Verified accurate (no finding)
- **Next.js 16** (docs `:954`) — `package.json` `next: 16.1.6`.
- **27 AI-assistant tools** (docs `:475`, `:826`, `:890`, `:931`) — exactly 27 `server.registerTool(...)` calls across `src/mcp/tools/*` (6 contacts + 8 email + 5 outreach + 6 upkeep + 2 calendar), and all 27 tool names match the docs list one-for-one.
- **24h free AI trial** (docs `:476`, `:907`) — `src/lib/openai.ts:39` `TRIAL_DURATION_MS = 24 * 60 …`.
- **500 MB upload limit + 8 audio/video formats** (docs `:760`) — `transcript-uploader.tsx:131` `MAX_AUDIO_SIZE = 500 * 1024 * 1024`; format list matches `AUDIO_ACCEPT`.
- **100/day Gmail send cap** (docs `:477`, `:730`; oauth consent `:161`) — `src/lib/email-send.ts:35` `DAILY_SEND_CAP = 100`.
- **100 calls/hour MCP rate limit** (docs `:890`) — `src/app/api/mcp/route.ts:26-29` `limit: 100, window: "1 h"`.

---

## Proposed cold-zone edits (for orchestrator to vet + apply)

All four are in the cold zone (`public/docs/index.html`, `src/app/oauth/**`). See `proposedColdEdits` in the structured output for exact current/replacement text. Summary:
1. `public/docs/index.html:791` — "Outreach" → "Outreach active" (T2), medium confidence.
2. `src/app/oauth/consent/page.tsx:152` — hardcoded title → `clientName` template (S1), medium confidence.
3. `src/app/oauth/consent/page.tsx:164` — "Claude's connector settings" → "your AI client's connector settings" (S1), medium confidence.
4. `src/app/oauth/consent/page.tsx:105` — "Claude needs your approval…" → "An app needs your approval…" (S1), medium confidence.
