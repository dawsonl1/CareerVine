# Dependency Vulnerability Report

**Date:** 2026-07-17
**Method:** `npm audit --json` run in each of the three npm packages. All three audits ran as full audits (careervine and careervine-mcp against installed `node_modules`; chrome-extension/panel-app resolved from `package-lock.json` because its `node_modules` is not installed — this is equivalent to `--package-lock-only` and yields the same advisory set). No fixes were applied.

## Summary

20 advisories total across the three packages: **10 high, 8 moderate, 2 low, 0 critical.**

| Package | Critical | High | Moderate | Low | **Total** | audit exit |
| --- | :--: | :--: | :--: | :--: | :--: | :--: |
| `careervine/` | 0 | 7 | 6 | 1 | **14** | 1 |
| `careervine-mcp/` | 0 | 0 | 0 | 0 | **0** | 0 |
| `chrome-extension/panel-app/` | 0 | 3 | 2 | 1 | **6** | 1 |
| **Total** | **0** | **10** | **8** | **2** | **20** | |

### Key takeaways

- **Every advisory has a fix available.** All 14 careervine advisories and 4 of the 6 extension advisories are fixable with `npm audit fix` (no `--force`, no breaking major). Only 2 extension advisories (`vite`, `esbuild`) require the breaking `vite` 5 → 8 major.
- **6 careervine advisories ship to users** (reach app runtime output): `next`, `ws`, `undici`, `linkify-it` (all high/transitive-or-direct) plus `dompurify` and `markdown-it` (moderate). These are the priority set. The single most impactful fix is bumping `next` 16.1.6 → 16.2.10 (non-breaking), which clears the largest cluster of high-severity advisories including SSRF, middleware/proxy auth bypass, and multiple DoS vectors.
- **The other 8 careervine advisories are dev-only** — entirely inside the ESLint (`eslint-config-next`) and Vitest test toolchains. They never reach production output.
- **All 6 extension advisories are dev-only build tooling** (`vite`, `postcss`, `esbuild`, `rollup`, `picomatch`, `@babel/core`). None ship in the packaged extension; its runtime deps (`react`, `react-dom`, `lucide-react`) are clean.
- **`careervine-mcp` is clean** — 0 advisories. It declares only devDependencies (`@types/node`, `tsx`, `typescript`) and no runtime dependencies.

"Ships vs dev-only" below is decided by whether the vulnerable package is reachable from production runtime code (a `dependencies` entry or a transitive dep of one) versus confined to `devDependencies` / build / test tooling. Reachability was spot-verified against source imports where relevant (`jsdom`/`dompurify` in `src/lib/ai/sanitize-email-html.ts`; `@tiptap` in `src/components/ui/rich-text-editor.tsx`).

---

## `careervine/` — 14 advisories (7 high, 6 moderate, 1 low)

Installed versions of note: `next@16.1.6`, `dompurify@3.3.3`, `ws@8.19.0`, `undici@7.24.5`, `linkify-it@5.0.0`, `markdown-it@14.1.1`, `jsdom@29.0.0`.

### HIGH

#### next  — **DIRECT · SHIPS**
- **Installed / vulnerable:** 16.1.6 (range `9.3.4-canary.0 - 16.3.0-canary.5`)
- **Path:** DIRECT `dependencies` entry (pinned exact `"next": "16.1.6"`). Also pulls the vulnerable `postcss` below.
- **Fix:** **Non-breaking** — `next@16.2.10` (`isSemVerMajor: false`). Bump `next` and the matching `eslint-config-next` (also pinned `16.1.6`, dev) together.
- **Advisories (18 merged):** the high ones include SSRF via WebSocket upgrades (GHSA-c4j6-fc7j-m34r), Middleware/Proxy auth bypass via dynamic route param injection / segment-prefetch / i18n (GHSA-492v-c6pp-mqqv, GHSA-267c-6grr-h53f, GHSA-26hh-7cqf-hhc6, GHSA-36qx-fr4f-26g5), and multiple DoS with Server Components / Cache Components (GHSA-q4gf-8mx6-v5v3, GHSA-8h8q-6873-q5fj, GHSA-mg66-mrh9-m8jx). Moderate ones include CSP-nonce XSS (GHSA-ffhc-5mcf-pf4q), Server Actions CSRF bypass (GHSA-mq59-m269-xvcx), and cache poisoning (GHSA-wfc6-r584-vfw7). **Highest-priority fix in the repo.**

#### ws  — **TRANSITIVE · SHIPS**
- **Installed / vulnerable:** 8.19.0 (range `8.0.0 - 8.20.1`)
- **Path:** TRANSITIVE via three runtime parents — `@supabase/realtime-js` (← `@supabase/supabase-js` ← `@supabase/ssr`), `openai`, and `@deepgram/sdk`. All are production `dependencies`.
- **Fix:** **Non-breaking** (`fixAvailable: true`).
- **Advisories:** Memory-exhaustion DoS from tiny fragments (high, GHSA-96hv-2xvq-fx4p); uninitialized-memory disclosure (moderate, GHSA-58qx-3vcg-4xpx).

#### undici  — **TRANSITIVE · SHIPS**
- **Installed / vulnerable:** 7.24.5 (range `7.0.0 - 7.27.2`)
- **Path:** TRANSITIVE via `jsdom@29.0.0`, which is a DIRECT production `dependencies` entry used server-side in `src/lib/ai/sanitize-email-html.ts`. (The same `jsdom` node is also a peer of `vitest`, but its production reachability is via the direct dep.)
- **Fix:** **Non-breaking** (`fixAvailable: true`).
- **Advisories:** TLS certificate validation bypass in SOCKS5 ProxyAgent (high, GHSA-vmh5-mc38-953g), WebSocket DoS via fragment-count bypass (high, GHSA-vxpw-j846-p89q), cross-origin request routing via SOCKS5 pool reuse (high, GHSA-hm92-r4w5-c3mj), plus Set-Cookie header injection and cache-related moderates.

#### linkify-it  — **TRANSITIVE · SHIPS**
- **Installed / vulnerable:** 5.0.0 (range `<=5.0.0`)
- **Path:** TRANSITIVE via `markdown-it` ← `prosemirror-markdown` ← `@tiptap/pm` ← `@tiptap/react` / `@tiptap/starter-kit` (the rich-text editor, `dependencies`, used in `src/components/ui/rich-text-editor.tsx`).
- **Fix:** **Non-breaking** (`fixAvailable: true`).
- **Advisory:** Quadratic-complexity ReDoS in `LinkifyIt#match` scan loop (high, GHSA-22p9-wv53-3rq4).

#### flatted  — **TRANSITIVE · DEV-ONLY**
- **Installed / vulnerable:** 3.3.3 (range `<=3.4.1`)
- **Path:** TRANSITIVE via `flat-cache` ← `file-entry-cache` ← `eslint` ← `eslint-config-next` (dev toolchain).
- **Fix:** **Non-breaking** (`fixAvailable: true`).
- **Advisories:** Unbounded-recursion DoS in `parse()` (high, GHSA-25h7-pfq9-p65f); prototype pollution via `parse()` (high, GHSA-rf6f-7fwh-wjgh).

#### minimatch  — **TRANSITIVE · DEV-ONLY**
- **Installed / vulnerable:** 3.1.2 (range `<=3.1.3 || 9.0.0 - 9.0.6`)
- **Path:** TRANSITIVE via `eslint` (root copy `3.1.2`) and `@typescript-eslint/typescript-estree` (nested `9.0.5`) — both under `eslint-config-next` (dev).
- **Fix:** **Non-breaking** (`fixAvailable: true`).
- **Advisories:** ReDoS via repeated wildcards (GHSA-3ppc-4f35-3m26), matchOne combinatorial backtracking (GHSA-7r86-cg39-jmmj), nested extglob catastrophic backtracking (GHSA-23c5-xmqv-rm74) — all high.

#### picomatch  — **TRANSITIVE · DEV-ONLY**
- **Installed / vulnerable:** 2.3.1 + 4.0.3/4.0.5 (range `<=2.3.1 || 4.0.0 - 4.0.3`)
- **Path:** TRANSITIVE via `vitest` (nested `4.0.3`, dev/test) and via `micromatch` ← `fast-glob` ← `@next/eslint-plugin-next` ← `eslint-config-next` (the `2.3.1` copy, dev).
- **Fix:** **Non-breaking** (`fixAvailable: true`).
- **Advisories:** ReDoS via extglob quantifiers (high, GHSA-c2c7-rcm5-vvqj); method injection in POSIX char classes (moderate, GHSA-3v7f-55p6-f55p).

### MODERATE

#### dompurify  — **DIRECT · SHIPS**
- **Installed / vulnerable:** 3.3.3 (range `<=3.4.10`)
- **Path:** DIRECT `dependencies` entry (`^3.3.3`). Imported in `src/lib/ai/sanitize-email-html.ts` and several email UI components (`compose-email-modal.tsx`, `inbox-shell.tsx`, `outreach-shell.tsx`, `contact-emails-tab.tsx`).
- **Fix:** **Non-breaking** — `npm audit fix` bumps to `3.4.11` (within `^3`, satisfies the pinned range).
- **Advisories (12 merged):** a long series of sanitizer-bypass / XSS issues — `ADD_TAGS`/`FORBID_TAGS` bypass (GHSA-39q2-94rc-95cp, GHSA-h7mw-gpvr-xq4m), prototype-pollution-to-XSS via CUSTOM_ELEMENT_HANDLING (GHSA-v9jr-rg53-9pgp), IN_PLACE / cross-realm bypasses, and config/hook pollution (GHSA-cmwh-pvxp-8882). Directly relevant since this is the app's HTML sanitizer for user/AI-generated email content.

#### markdown-it  — **TRANSITIVE · SHIPS**
- **Installed / vulnerable:** 14.1.1 (range `<=14.1.1`)
- **Path:** TRANSITIVE via `prosemirror-markdown` ← `@tiptap/pm` ← `@tiptap` editor (`dependencies`). Same ship path as `linkify-it`.
- **Fix:** **Non-breaking** (`fixAvailable: true`).
- **Advisory:** Quadratic-complexity DoS in the smartquotes rule (GHSA-6v5v-wf23-fmfq).

#### postcss  — **TRANSITIVE · build tooling (does not reach browser output)**
- **Installed / vulnerable:** nested under `next` (range `<8.5.10`)
- **Path:** TRANSITIVE via `next` only (`node_modules/next/node_modules/postcss`). Used for build-time CSS processing, not shipped as browser JS.
- **Fix:** **Non-breaking** — resolved by the same `next@16.2.10` bump (`isSemVerMajor: false`).
- **Advisory:** XSS via unescaped `</style>` in CSS stringify output (GHSA-qx2v-qp2m-jg93). Low practical exposure here (build-time, trusted CSS input).

#### ajv  — **TRANSITIVE · DEV-ONLY**
- **Vulnerable:** `<6.14.0` (installed `6.12.6`). Path: `eslint` ← `eslint-config-next` (dev). **Fix:** non-breaking. Advisory: ReDoS with the `$data` option (GHSA-2g4f-4pwh-qvx6).

#### brace-expansion  — **TRANSITIVE · DEV-ONLY**
- **Vulnerable:** `<1.1.13 || >=2.0.0 <2.0.3` (installed `1.1.12` under `minimatch`/`eslint`, `2.0.2` under `@typescript-eslint/typescript-estree`). Path: `eslint-config-next` toolchain (dev). **Fix:** non-breaking. Advisory: zero-step-sequence process hang / memory exhaustion (GHSA-f886-m6hf-6m8v).

#### js-yaml  — **TRANSITIVE · DEV-ONLY**
- **Vulnerable:** `4.0.0 - 4.1.1` (installed `4.1.1`). Path: `@eslint/eslintrc` ← `eslint` ← `eslint-config-next` (dev). **Fix:** non-breaking. Advisory: quadratic-complexity DoS in merge-key alias handling (GHSA-h67p-54hq-rp68).

### LOW

#### @babel/core  — **TRANSITIVE · DEV-ONLY**
- **Installed / vulnerable:** 7.29.0 (range `<=7.29.0`). Path: `eslint-plugin-react-hooks` ← `eslint-config-next` (dev). **Fix:** non-breaking. Advisory: arbitrary file read via `sourceMappingURL` comment (GHSA-4x5r-pxfx-6jf8).

---

## `careervine-mcp/` — 0 advisories

Clean audit (exit 0, `metadata.vulnerabilities.total = 0`). The package declares no runtime `dependencies` — only devDependencies (`@types/node`, `tsx`, `typescript`), none of which currently carry advisories. Nothing to fix.

---

## `chrome-extension/panel-app/` — 6 advisories (3 high, 2 moderate, 1 low)

**All six are dev-only build tooling.** None ship in the packaged extension — the runtime `dependencies` (`react`, `react-dom`, `lucide-react`) are clean. Audit resolved from `package-lock.json` (no `node_modules` installed); parents derived from the lockfile.

### HIGH

#### vite  — **DIRECT · DEV-ONLY (build tooling)**
- **Declared / vulnerable:** `^5.1.5` (range `<=6.4.2`)
- **Path:** DIRECT `devDependencies`. Pulls the vulnerable `esbuild` and `rollup` below.
- **Fix:** **BREAKING major** — only `vite@8.1.5` (`isSemVerMajor: true`); `npm audit fix` will not apply it without `--force`. Requires a Vite 5 → 8 migration.
- **Advisories:** `server.fs.deny` bypass on Windows alternate paths (high, GHSA-fx2h-pf6j-xcff), path traversal in optimized-deps `.map` handling (moderate, GHSA-4w7w-66w2-5vf9), and `launch-editor` NTLMv2 hash disclosure (moderate, GHSA-v6wh-96g9-6wx3). All affect the **dev server only**; the production extension bundle is unaffected.

#### rollup  — **TRANSITIVE · DEV-ONLY (build tooling)**
- **Vulnerable:** `4.0.0 - 4.58.0`. Path: TRANSITIVE via `vite` (dev). **Fix:** **Non-breaking** (`fixAvailable: true`, bump within Rollup 4.x to ≥4.59.0). Advisory: arbitrary file write via path traversal (high, GHSA-mw96-cpmx-2vgc).

#### picomatch  — **TRANSITIVE · DEV-ONLY (build tooling)**
- **Vulnerable:** `<=2.3.1 || 4.0.0 - 4.0.3`. Path: TRANSITIVE via `tinyglobby`, `micromatch`, `anymatch`, `readdirp` (the Vite/PostCSS/Tailwind build chain, dev). **Fix:** **Non-breaking** (`fixAvailable: true`). Advisories: ReDoS via extglob quantifiers (high, GHSA-c2c7-rcm5-vvqj); POSIX char-class method injection (moderate).

### MODERATE

#### esbuild  — **TRANSITIVE · DEV-ONLY (build tooling)**
- **Vulnerable:** `<=0.24.2`. Path: TRANSITIVE via `vite` (dev). **Fix:** **BREAKING** — only resolved by `vite@8.1.5` (`isSemVerMajor: true`); tied to the Vite major above. Advisory: dev server accepts cross-site requests and leaks responses (GHSA-67mh-4wv8-2f99) — dev-server-only exposure.

#### postcss  — **DIRECT · DEV-ONLY (build tooling)**
- **Declared / vulnerable:** `^8.4.47` (range `<8.5.10`). Path: DIRECT `devDependencies` (Tailwind/PostCSS build). **Fix:** **Non-breaking** — bump to `8.5.10` within `^8`. Advisory: XSS via unescaped `</style>` in CSS stringify output (GHSA-qx2v-qp2m-jg93).

### LOW

#### @babel/core  — **TRANSITIVE · DEV-ONLY (build tooling)**
- **Vulnerable:** `<=7.29.0`. Path: TRANSITIVE via `@vitejs/plugin-react` (dev). **Fix:** **Non-breaking** (`fixAvailable: true`). Advisory: arbitrary file read via `sourceMappingURL` comment (GHSA-4x5r-pxfx-6jf8).

---

## Suggested remediation order (no fixes applied here)

1. **`careervine`: bump `next` 16.1.6 → 16.2.10** (+ `eslint-config-next` to match). Non-breaking; clears the largest high-severity cluster (SSRF, proxy/middleware auth bypass, DoS) and the transitive `postcss` advisory. This is the single highest-value change.
2. **`careervine`: `npm audit fix`** (no `--force`) to sweep the remaining 13 — resolves the shipping `ws`, `undici`, `linkify-it`, `dompurify`, `markdown-it` plus all dev-only ESLint/Vitest advisories in one pass. Re-run tests + build afterward.
3. **`chrome-extension`: `npm audit fix`** clears `postcss`, `rollup`, `picomatch`, `@babel/core` (non-breaking). The remaining `vite`/`esbuild` pair needs a deliberate Vite 5 → 8 major upgrade — dev-server-only exposure, so lower urgency, but worth scheduling.
4. **`careervine-mcp`:** nothing to do.
