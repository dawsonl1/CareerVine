/**
 * Keeps careervine/CONVENTIONS.md honest (CAR-157, F16/F17).
 *
 * The doc it guards replaced ARCHITECTURE.md, which rotted into a majority-false
 * map of the codebase because nothing ever checked it. Four layers of guard:
 *
 *   1. Every repo-root-relative path the doc cites must exist on disk — a rename
 *      turns the doc red instead of quietly stale.
 *   2. Citations must BE repo-root-relative: a `src/...` span is invisible to
 *      layer 1 (the allowlist filter drops it), so the convention is enforced
 *      rather than assumed.
 *   3. Every symbol the doc names is asserted to exist in the file the doc
 *      points at — a symbol rename is likelier than a file move.
 *   4. The doc's counted claims (routes, wrapper adoption, schedules, capability
 *      keys) are recomputed from the codebase and matched against the prose —
 *      the root README's route count rotted 61 → 105 before CAR-157 removed it,
 *      and an unpinned count here would rot the same way.
 *
 * This still proves pointers and counts, not prose truth in general.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fg from "fast-glob";
// Import-safe: the registry's CLI only runs when executed directly.
import { SCHEDULES } from "../../scripts/qstash-schedules.mjs";

// Resolved from this file, not process.cwd(), so the test is invocation-independent
// (CI runs vitest from careervine/, a local run may not).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const DOC_PATH = path.join(REPO_ROOT, "careervine", "CONVENTIONS.md");

/**
 * Top-level directories a repo-relative citation may start with. An allowlist
 * rather than a general path regex, so backticked prose like `admin/` (a route
 * prefix) or `{ success: true }` is never mistaken for a file to resolve.
 */
const TOP_LEVEL = [
  "careervine",
  "careervine-mcp",
  "chrome-extension",
  "supabase",
  "scripts",
  "docs",
  "pipelines",
  "research",
  "ai-instruction",
  "\\.claude",
  "\\.github",
];

const CITATION = new RegExp(`^(?:${TOP_LEVEL.join("|")})/[^\\s*]+$`);

function backtickSpans(markdown: string): string[] {
  return (markdown.match(/`[^`\n]+`/g) ?? []).map((s) => s.slice(1, -1).trim());
}

function citedPaths(markdown: string): string[] {
  const found = backtickSpans(markdown)
    .filter((s) => CITATION.test(s))
    // Tolerate a trailing :line or :line-line hint, and a trailing slash on dirs.
    .map((s) => s.replace(/:\d+(?:-\d+)?$/, "").replace(/\/$/, ""));
  return [...new Set(found)];
}

/**
 * Symbols the doc names, each asserted to exist (word-bounded) in the file the
 * doc's prose associates it with. Closes the false-green where a cited file
 * survives a rename of the symbol inside it.
 */
const SYMBOL_CLAIMS: Array<[file: string, symbols: string[]]> = [
  ["careervine/src/lib/api-handler.ts", ["withApiHandler", "ApiError", "requireCapability", "InferApiResponse"]],
  ["careervine/src/lib/api-client.ts", ["apiFetch", "apiSend", "ApiRequestError"]],
  ["careervine/src/lib/qstash-verify.ts", ["withQStashVerification"]],
  ["careervine/src/lib/cron-guard.ts", ["withCronGuard"]],
  ["careervine/src/lib/capabilities/map.ts", ["capabilitiesFor"]],
  ["careervine/src/lib/capabilities/resolve.ts", ["resolveCapabilities"]],
  ["careervine/src/hooks/use-capabilities.ts", ["useCapabilities"]],
  ["careervine/src/components/capable.tsx", ["Capable"]],
  ["careervine/src/lib/data/client.ts", ["db", "setDataClient", "must"]],
  ["careervine/src/lib/rules/network-status.ts", ["isActiveContact"]],
  ["careervine/src/lib/rules/neglected.ts", ["deriveNeglectedContacts"]],
  ["careervine/src/lib/notify/email.ts", ["sendAppEmail"]],
  ["careervine/src/lib/email-send.ts", ["sendTrackedEmail", "SendPolicyError"]],
  ["careervine/src/lib/ui-events.ts", ["emitUiEvent", "onUiEvent"]],
  ["careervine/src/components/ui/modal.tsx", ["useModalPortalContainer", "useModalDismiss", "useDialogLayer"]],
  ["careervine/src/components/ui/select.tsx", ["ariaLabel"]],
  ["careervine/src/components/ui/month-year-picker.tsx", ["ariaLabel"]],
  ["careervine/src/hooks/use-latest-request.ts", ["useLatestRequest", "begin", "isLatest"]],
  ["careervine/src/__tests__/route-auth-inventory.test.ts", ["HAND_ROLLED"]],
  ["careervine/src/lib/admin-auth.ts", ["isAuthorizedAdminToken"]],
  ["careervine/src/components/compose-email-modal.tsx", ["submittingRef"]],
  ["careervine/src/components/contacts/contact-edit-modal.tsx", ["savingRef"]],
  ["careervine/src/__tests__/helpers/fake-fetch.ts", ["installFakeFetch", "unmatched"]],
];

const WORDS = [
  "Zero", "One", "Two", "Three", "Four", "Five", "Six",
  "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
  "Thirteen", "Fourteen", "Fifteen",
];

describe("CONVENTIONS.md", () => {
  const markdown = readFileSync(DOC_PATH, "utf8");
  const paths = citedPaths(markdown);

  it("cites a meaningful number of paths", () => {
    // Guards against a regex or allowlist change silently shrinking coverage,
    // which would make the per-path assertions vacuously narrow. Keep the floor
    // snug — a large gap here tolerates silent citation loss.
    //
    // Re-snugged in CAR-208. The floor was 35 against a documented "actual count
    // at time of writing: 39"; the doc has since grown to 105 citations, so two
    // thirds of the pointers could have vanished with this still green — the
    // exact erosion the comment warns about, in the guard against it.
    expect(paths.length).toBeGreaterThanOrEqual(100);
  });

  it.each(paths)("cited path exists: %s", (rel) => {
    expect(existsSync(path.join(REPO_ROOT, rel))).toBe(true);
  });

  it("cites paths repo-root-relative, never careervine-relative", () => {
    // A `src/...` span is invisible to the existence check above (the allowlist
    // drops it), so it would be an UNGUARDED citation — the exact quiet-rot
    // failure this file exists to prevent.
    //
    // `app/` is in the list because of CAR-184: three route-boundary citations were
    // written as `app/error.tsx` and slipped through BOTH layers — the existence
    // check ignored them (no `careervine/` prefix) and this guard could not see them
    // either, because its prefix list started at src|public|scripts. Any new segment
    // that can begin a careervine-relative path belongs here — but only if it is
    // NOT also a real repo-root directory, or this guard would reject valid
    // citations. `app/` qualifies (there is no repo-root `app/`); `supabase/`
    // deliberately does not, since `supabase/migrations/...` is a valid root path.
    const careervineRelative = backtickSpans(markdown).filter((s) =>
      /^(src|public|scripts|app)\/[^\s]*$/.test(s),
    );
    expect(
      careervineRelative,
      `citations must start at the repo root (prefix with careervine/): ${careervineRelative.join(", ")}`,
    ).toEqual([]);
  });

  it.each(SYMBOL_CLAIMS)("symbols the doc names exist in %s", (file, symbols) => {
    const text = readFileSync(path.join(REPO_ROOT, file), "utf8");
    for (const symbol of symbols) {
      expect(
        new RegExp(`\\b${symbol}\\b`).test(text),
        `${file} no longer contains "${symbol}" — update CONVENTIONS.md (and this map) to match the rename`,
      ).toBe(true);
    }
  });

  it("does not cite the map it replaced", () => {
    // ARCHITECTURE.md was deleted by CAR-157. A citation of it would mean the
    // comprehensive-map anti-pattern crept back in.
    expect(existsSync(path.join(REPO_ROOT, "careervine", "ARCHITECTURE.md"))).toBe(false);
  });

  it("covers the API route convention", () => {
    // Exit criterion: `rg withApiHandler --glob '*.md'` must hit this doc.
    expect(markdown).toContain("withApiHandler");
  });

  describe("counted claims match the codebase", () => {
    const apiDir = path.join(REPO_ROOT, "careervine", "src", "app", "api");
    const routeFiles = fg.sync("**/route.{ts,tsx,js,jsx,mjs}", { cwd: apiDir, dot: true });
    const total = routeFiles.length;
    const wrapped = routeFiles.filter((f) =>
      /\bwithApiHandler\s*[<(]/.test(readFileSync(path.join(apiDir, f), "utf8")),
    ).length;
    const skip = total - wrapped;

    it("route census (a route count rotted 61 → 105 in the old README)", () => {
      for (const needle of [
        `${total} routes live under`,
        `${wrapped} of them go through`,
        `The ${skip} routes that skip`,
        `The ${skip} routes that deliberately skip`,
      ]) {
        expect(markdown, `doc must say "${needle}" — the codebase moved; update the prose`).toContain(needle);
      }
    });

    it("schedule count", () => {
      expect(markdown).toContain(`${WORDS[SCHEDULES.length]} QStash schedules`);
    });

    it("E2E flow count (CAR-191)", () => {
      // Section i states a flow count, and an unpinned count is exactly the rot
      // this file exists to stop — the same failure the route census records.
      const specs = fg.sync("*.spec.ts", {
        cwd: path.join(REPO_ROOT, "careervine", "e2e"),
      });
      expect(specs.length).toBeGreaterThan(0);
      expect(
        markdown,
        `doc must say "${WORDS[specs.length]} flows" — e2e/ now has ${specs.length} specs`,
      ).toContain(`${WORDS[specs.length]} flows`);
    });

    it("E2E own-identity spec count (CAR-208)", () => {
      // Section i said "Two specs mint their own identity" while three did, and
      // the flow-count pin above could not see it — it counts spec FILES, and
      // this is a claim about what those files do. CAR-191 added the third in
      // its own commits, so the sentence was false the day it was written.
      //
      // Minting is `mintSessionUrl` called from a spec BODY. auth.setup.ts calls
      // it too, and is deliberately not a spec: it mints the one shared identity
      // these three opt out of.
      const e2e = path.join(REPO_ROOT, "careervine", "e2e");
      const minting = fg
        .sync("*.spec.ts", { cwd: e2e })
        .filter((f) => /\bmintSessionUrl\s*\(/.test(readFileSync(path.join(e2e, f), "utf8")));

      expect(minting.length).toBeGreaterThan(0);
      // Matched against whitespace-normalized prose. The claim is six words
      // long and the doc is hard-wrapped, so a raw `toContain` pins the line
      // breaks as much as the words — it would go red on a pure reflow, which
      // is the brittleness that makes people delete pins rather than fix them.
      expect(
        markdown.replace(/\s+/g, " "),
        `doc must say "${WORDS[minting.length]} specs mint their own identity" — ` +
          `these do: ${minting.join(", ")}`,
      ).toContain(`${WORDS[minting.length]} specs mint their own identity`);
    });

    it("only one spelling of the non-dialog-overlay escape hatch exists (CAR-208)", () => {
      // The dialog rule had two guards accepting near-anagram tokens, and
      // neither honoured the other's: a contributor with a legitimate
      // non-dialog overlay would write whichever the first error named and stay
      // red against the second. CAR-208 deleted the duplicate guard; this stops
      // its token coming back anywhere — including in the prose that would
      // teach someone to write it.
      // Scoped to the tree an annotation would be WRITTEN in, not to every
      // mention: the prose in CONVENTIONS.md and the headers in
      // check-conventions.mjs name the retired token in order to explain why it
      // is retired, and a scan that failed on those would force the explanation
      // out of the codebase — deleting the only record of the trap.
      const src = path.join(REPO_ROOT, "careervine", "src");
      const files = fg.sync(["**/*.{ts,tsx}"], {
        cwd: src,
        // `**/` on both, not the bare `__tests__/**` a first cut used: that
        // anchors to the glob root, so it excluded only the top-level
        // `src/__tests__/` and left every nested test tree in scope.
        ignore: ["**/__tests__/**", "**/*.test.{ts,tsx}"],
      });

      // An anti-vacuity FLOOR, which every other pin in this file has and this
      // one shipped without. `toEqual([])` over a glob that matched nothing
      // passes and reports success — and fast-glob returns `[]` for a missing
      // cwd rather than throwing, so a rename of `careervine/src` would retire
      // the guard silently. This is the "absence assertions pass vacuously
      // unless sequenced" trap, in the file written to close that class.
      expect(files.length).toBeGreaterThan(300);

      const hits = files.filter((f) =>
        readFileSync(path.join(src, f), "utf8").includes("overlay-not-a-dialog:"),
      );

      expect(
        hits,
        "this annotation does nothing — the guard that honoured it was deleted in CAR-208. " +
          "The one spelling is `non-dialog-overlay:`, enforced by " +
          "src/__tests__/dialog-adoption.test.ts.",
      ).toEqual([]);
    });

    it("every per-area coverage threshold glob still matches files (CAR-208)", () => {
      // Vitest resolves a non-metric threshold key as a picomatch glob against
      // each file's path, and `checkThresholds` computes `uncovered = total -
      // covered` over whatever that glob selected. A glob matching ZERO files
      // yields an empty coverage map, `0 > 430` is false, and the budget passes
      // as a silent no-op — no error, no reporter difference. Rename `src/mcp`
      // and all four of its budgets stop gating with nothing to show for it.
      //
      // This asserts the keys still bind, which is the one property the config
      // cannot state about itself.
      const config = readFileSync(
        path.join(REPO_ROOT, "careervine", "vitest.config.ts"),
        "utf8",
      );
      const globs = [...config.matchAll(/^\s*'([^']+\/\*\*)':\s*\{/gm)].map((m) => m[1]);

      expect(globs.length).toBeGreaterThanOrEqual(3);
      for (const glob of globs) {
        const matched = fg.sync(`${glob}/*.{ts,tsx}`, {
          cwd: path.join(REPO_ROOT, "careervine"),
          ignore: ["**/__tests__/**", "**/*.test.{ts,tsx}"],
        });
        expect(matched.length, `coverage threshold "${glob}" matches no files — it is a no-op`).toBeGreaterThan(0);
      }
    });

    it("capability key count", () => {
      const types = readFileSync(
        path.join(REPO_ROOT, "careervine", "src", "lib", "capabilities", "types.ts"),
        "utf8",
      );
      // One `| "key"` per line; counting line-anchored members survives inline
      // comments (one of which contains a semicolon that broke a slice approach).
      const keys = (types.match(/^\s*\|\s*"[^"]+"/gm) ?? []).length;
      expect(keys).toBeGreaterThan(0);
      expect(markdown).toContain(`${WORDS[keys]} keys exist today`);
    });
  });
});
