# Public-pages performance / bundle audit

**Task 6 — STATIC analysis only.** No dev server, no production fetch, no Lighthouse run was performed. All numbers below come from reading the source files on disk and from local `gzip`/`brotli` compression of the exact bytes that ship. Wire-transfer and cache-header behavior are inferred from `next.config.ts` + Vercel defaults and flagged as "verify in production" where that matters.

Date: 2026-07-17
Scope: the public / marketing / docs surface under `careervine/public/`, primarily `careervine/public/docs/index.html`.

---

## Summary

The public static surface is **small and already well-optimized**. The docs page makes **zero external requests** — no web fonts, no external CSS, no external JS, no CDN, no raster images. Everything is inline or a system font. The one HTML document (`public/docs/index.html`, 85,081 bytes uncompressed) compresses to **~20.7 KB gzip / ~17.3 KB brotli**, which is the entire page's real wire cost. There are **no render-blocking network resources**, and the unused-CSS ratio is **effectively 0%**.

Consequently there are **no high-impact wins here** — the findings are minor hygiene and marginal byte reductions that gzip/brotli already largely neutralize. The single biggest real-wire lever is simply confirming that Vercel serves this file compressed (it does by default). The prioritized list below is honest about the small size of each saving.

### Byte-weight ledger — `public/docs/index.html`

| Region | Lines | Uncompressed bytes | Share |
|---|---|---|---|
| **Total file** | 1–1090 | **85,081** | 100% |
| Doctype + `<head>` meta/favicon/title | 1–11 | 946 | 1.1% |
| Inline `<style>` block | 12–400 | 17,713 | 20.8% |
| Body markup (semantic content + inline SVG) | 402–959 | 61,374 | 72.1% |
| Inline `<script>` block | 960–1087 | 5,023 | 5.9% |
| **Compressed (gzip)** | — | **20,709** | 24.3% of raw |
| **Compressed (brotli)** | — | **17,289** | 20.3% of raw |

### Asset inventory — everything under `public/`

| File | Bytes | Notes |
|---|---|---|
| `docs/index.html` | 85,081 | The audited docs page. |
| `next.svg` | 1,375 | Next.js starter template leftover — **0 references** in `src`/`app`. |
| `globe.svg` | 1,035 | Starter leftover — **0 references**. |
| `file.svg` | 391 | Starter leftover — **0 references**. |
| `window.svg` | 385 | Starter leftover — **0 references**. |
| `vercel.svg` | 128 | Starter leftover — **0 references**. |
| `sitemap.xml` | 359 | Fine. |
| `robots.txt` | 255 | Fine. |

There are **no raster images anywhere** in `public/` — so there is no PNG/JPEG-vs-WebP/AVIF optimization to do, and no image over 100 KB. The image-weight axis of this audit is clean.

---

## Detailed measurements

### Inline vs external assets

- **External stylesheets (`<link rel="stylesheet">`):** 0.
- **External scripts (`<script src>`):** 0.
- **Web fonts:** 0 — `@font-face` count is 0, external `url(...)` count is 0. The page uses only OS system-font stacks (`-apple-system`, `Georgia`, `ui-monospace`).
- **Inline `<style>` blocks:** 1 (17,713 bytes).
- **Inline `<script>` blocks:** 1 (5,023 bytes).
- **`<img>` tags:** 0.
- **Inline `<svg>` blocks:** 44 (see dedup note below).
- **Data URIs:** 1 — the favicon is an inline SVG `data:` URI (`<link rel="icon">`), so it costs **no** extra request. No base64 blobs anywhere.

This is close to the ideal shape for a standalone doc: a single self-contained HTML document with no request fan-out.

### Render-blockers

- **Synchronous external scripts in `<head>`:** none.
- **External stylesheets in `<head>`:** none.
- The one `<script>` is inline and placed at the **end of `<body>`** (line 960), so it runs after HTML parse — non-render-blocking by position (no `defer`/`async` needed).
- The inline `<style>` sits in `<head>`. It is technically parse-blocking for first paint, but because it is **inline** there is no network round-trip — this is the recommended "inline critical CSS" pattern for a single-document page. **No action.**
- CSS rendering-cost features are negligible: 4 `@media` queries, 0 `@keyframes`/animations, 1 `backdrop-filter`, 2 `box-shadow`. Nothing expensive.

### How it is served

- `next.config.ts` `rewrites().beforeFiles` maps `docs.careervine.app/:path*` → `/docs/index.html` (host-scoped; consistent with rule 33 — routing lives in `next.config.ts`, not `vercel.json`).
- `vercel.json` sets only `regions: ["pdx1"]`; it defines **no cache/compression headers** for the docs HTML. Vercel applies gzip/brotli to text responses automatically, so the ~85 KB document ships as ~17–20 KB. **Verify in production** (cannot be confirmed by static analysis): confirm the response carries `content-encoding: br` (or `gzip`) and reasonable `cache-control`. Leaving HTML on a revalidating default is appropriate — this page changes with the app (rule 34), so it should **not** be immutably cached.

### Unused-CSS heuristic

- Distinct class selectors defined in the `<style>` block: **73**.
- Distinct class tokens actually used in `class="..."` attributes: **72**.
- Defined-but-not-in-static-markup: **exactly 1** — `.nav-open`, and that class is applied at runtime by the inline script (`body.classList.toggle('nav-open')`), so it **is** used.
- **Estimated unused-CSS ratio: ~0%.** The stylesheet is tightly scoped to the page. There is no dead-CSS win here.

### Inline-SVG repetition

- 44 inline `<svg>` blocks, but only **10 are unique**. The three most-repeated paths:
  - vine/leaf logo `M20 4C10 4 4 10 4 20c8 .5 16-4 16-16Z` — 18×
  - arrow `M5 12h14M13 6l6 6-6 6` — 13×
  - chevron `M9 6l6 6-6 6` — 8×
- Total inline-SVG weight ≈ 7,626 bytes uncompressed.
- **Important caveat:** these repeats are identical strings, which gzip/brotli deduplicate almost perfectly. A `<symbol>`/`<use>` sprite would cut ~5 KB of *raw* markup but only ~0.5–1 KB off the *compressed* wire size. Low real payoff, and it touches shared layout markup. Recommend only if bundled with a minification pass.

### Minification headroom (measured)

- 7,480 bytes of leading indentation whitespace, 90 blank lines, 25 CSS comment blocks, 12 HTML comments, 2 JS comments.
- Crude minify (strip leading whitespace + blank lines only): 85,081 → **78,485** bytes raw (−6,596, ~8%), but gzip only moves **20,709 → 20,331** (−378 bytes, ~1.8%).
- A full minifier (collapse inter-tag whitespace, drop comments, minify the CSS/JS) would do somewhat better — realistically landing near ~15–17 KB gzip — but the absolute saving is still only ~**2–4 KB** on the wire. This is why minification sits low on the list despite the big raw-byte delta: **compression already absorbs most of it.**

---

## Prioritized fix list (highest impact first — recommend only, do NOT apply)

> Fixes touch shared layout/markup and the deploy pipeline. Per task instructions these are recommendations only.

1. **Verify production compression + cache headers (near-zero effort, protects the biggest lever).**
   The entire page's wire cost is the single compressed HTML transfer (~17–20 KB). The one thing that would *actually* hurt performance is if compression were somehow not applied. Static analysis can't confirm the live response, so: confirm `docs.careervine.app` returns `content-encoding: br`/`gzip` and a sane `cache-control` on the HTML. **Est. savings:** none if already correct (expected); prevents a silent ~65 KB regression if it isn't.

2. **Add an HTML minification step for `public/docs/index.html` in the build.**
   Strip comments, collapse whitespace, minify the inline CSS/JS. **Est. savings:** ~6–8 KB uncompressed and ~2–4 KB gzip (measured floor 20,709 → 20,331 for whitespace-only; a real minifier does better). Low absolute payoff because gzip already handles whitespace/repetition; do it only if it can be automated (e.g., a prebuild transform) rather than hand-editing the authored file, since the file is hand-maintained per rule 34.

3. **Deduplicate the 44 inline SVGs into a `<symbol>`/`<use>` sprite (bundle with #2 or skip).**
   10 unique icons, logo repeated 18×, arrow 13×, chevron 8×. **Est. savings:** ~5 KB raw, only ~0.5–1 KB gzip. Marginal on the wire and it edits shared markup — only worth doing alongside a minification pass, not on its own.

4. **Delete the 5 unused Next.js starter SVGs from `public/` (repo hygiene, ~0 perf).**
   `next.svg`, `vercel.svg`, `globe.svg`, `file.svg`, `window.svg` — total 3,314 bytes, **0 references** across `src`/`app`. They are never requested, so this is cleanup, not a performance win. **Est. savings:** 0 KB wire; removes 5 dead files. (Note: this overlaps the dead-code/asset inventory in Task 3 — dedupe there.)

---

## What is explicitly NOT a problem here

- No web fonts / no FOUT/FOIT risk.
- No render-blocking external CSS or synchronous head scripts.
- No raster images; nothing >100 KB; no non-next-gen image formats to convert.
- No unused CSS of consequence (~0%).
- No request fan-out — one self-contained document.

## Out of scope for this static pass

The primary marketing/landing page and legal pages (`/`, `/privacy`, `/reset-password`, etc.) are **server-rendered Next.js React routes**, not files under `public/`, so their JS-bundle weight, code-splitting, and `next/image` usage are **not** measurable by this static file-level audit. If a full landing-page performance number is wanted, it needs a production Lighthouse/WebPageTest run or a `next build` bundle-analyzer pass — neither of which was run here (static analysis only, per task).
