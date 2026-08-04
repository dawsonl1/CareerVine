# CAR-224 — Restore CONVENTIONS.md to a pointer index

## Problem

CAR-157 built this file as "a pointer index into authoritative code headers." It has drifted
back into being the map it replaced: 7,596 words, ~25-30% pointer / ~70% restated content.
It is read before every non-trivial code change, so its size is a per-task cost.

Section f alone is 3,313 words (44% of the doc). Section i is 1,357 words at 8% pointer density.

## Principle

**Relocate, do not delete.** Most of this prose is hard-won (the CAR-196 false-green, the
`fetch`-in-read-verbs warning, the `fireEvent.click` note). It is valuable but it is not a
pointer index. It goes into the headers the doc already cites, which is what the doc's own
preamble prescribes. Deleting it would be the easy option and the wrong one.

The test enforces the shape of what remains, so the citations must survive the cut:
`conventions-doc.test.ts` checks 114 distinct paths with a floor of `>= 100`, plus 23
`SYMBOL_CLAIMS` and recomputed counted claims. Pointers stay, narrative moves.

## Relocation map

Partitioned so no two workstreams touch the same file.

| Narrative block | Words | Destination header |
|---|---:|---|
| f: detector baselines, ratchet algebra, the 35→54→129 history, the over-count rationale | ~936 | `careervine/scripts/lib/ratchet.mjs` |
| f: no-raw-fetch import-graph rule + CAR-207 post-mortem | ~254 | the check's comment in `careervine/scripts/check-conventions.mjs` |
| f: modal two-layer split, portal/dismiss rules, worked examples | ~520 | `careervine/src/components/ui/modal.tsx` |
| f: escape ownership, the two mechanisms, the ownership check | ~331 | `use-portal-dropdown.ts` + `use-dropdown-escape.ts` |
| h: `vi.mock` factory typing rationale, TDZ/hoisting trap | ~143 | `careervine/src/__tests__/helpers/typed-mock.ts` |
| h: `installFakeFetch` vs the older idiom | ~118 | `careervine/src/__tests__/helpers/fake-fetch.ts` |
| h: coverage-as-gate rationale, per-area budgets, MCP history | ~200 | `careervine/vitest.config.ts` |
| i: stub-layer split, read-back mechanism, CI-run false-green | ~288 | `careervine/e2e/server-stubs/register.mjs` |
| i: env allowlist, the three sources, blanked-vs-pinned trap | ~144 | `careervine/e2e/helpers/env-allowlist.ts` |
| i: shared tenant, worker model, `afterEach` restore rule | ~206 | `careervine/e2e/helpers/tenant.ts` |
| i: selector policy, negative-assertion sequencing | ~265 | `careervine/e2e/fixtures/test.ts` |
| d/e: school-affinity history, bounce-parse bias | ~180 | `lib/data/client.ts`, `lib/bounce-parse.ts` |

## Execution

1. Fan out one agent per workstream. Each **only** appends to code headers and reports what it
   moved. **No agent edits CONVENTIONS.md** — that would race on one file.
2. I rewrite the doc in a single pass afterward, replacing each moved block with a pointer and
   keeping every citation.
3. Verify: `conventions-doc.test.ts`, `npm run check:conventions`, `npm run test`,
   `npm run lint`, `npx tsc --noEmit`.
4. Re-measure pointer density and word count against the ~2,000-word target.

## Risks

- **Citation floor.** Cutting prose can drop a path below the `>= 100` floor. Check the count
  after the rewrite, not just that tests pass.
- **Counted claims.** Route counts, wrapper adoption, schedule count, capability keys, and the
  nine-flow count are recomputed from the codebase; keep those sentences intact.
- **`SYMBOL_CLAIMS`.** 23 file→symbol pairs are asserted word-bounded in the cited file. Do not
  drop a sentence naming one of those symbols.
- Headers are read by humans mid-task; keep them scannable rather than dumping the doc's prose in
  verbatim.
