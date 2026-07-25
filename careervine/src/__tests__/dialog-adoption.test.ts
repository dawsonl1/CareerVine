/**
 * Every full-screen overlay in this app is a real dialog, and every dialog has a
 * name (CAR-197).
 *
 * CONVENTIONS.md §f has said "new modals use modal.tsx" since CAR-185 with nothing
 * enforcing it, and twelve dialogs had already been hand-rolled past it: no
 * `role`, no `aria-modal`, no focus trap. A keyboard user tabbed straight out of
 * the follow-up modal into the page behind it.
 *
 * A source scan rather than a render test, for the same three reasons
 * `select-aria-label.test.ts` gives: nothing on screen changes, no render test
 * covers a dialog nobody wrote one for, and the 13th hand-rolled dialog is
 * exactly where the rule recurs. axe cannot cover it either — it has no
 * focus-trap rule at all, and an overlay with no `role` is not a dialog to axe,
 * so the accessibility gate reads green over precisely the broken ones.
 *
 * ── Why the accounting assertion exists ──
 *
 * The scan reads `className` attributes, so a `fixed inset-0` assembled in a const
 * or a `cn()` call would be invisible to it and the guard would pass while the
 * overlay it was written to catch sat right there. So every occurrence of the
 * string in the file has to be *accounted for* by one of the recognised shapes.
 * An unrecognised one fails with "the guard cannot see this", which is the honest
 * failure: extend the scanner, do not work around it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fg from "fast-glob";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..");

/** The marker of a full-screen overlay: pinned to the viewport on all four sides. */
const OVERLAY_CLASS = "fixed inset-0";

/**
 * The primitive itself. It renders the wrapper, the scrim and the surface as
 * separate elements, so its wrapper legitimately carries the class with no role —
 * the role goes on the surface inside it.
 */
const PRIMITIVE = "components/ui/modal.tsx";

/**
 * Props that hand a class string to `DialogSurface` rather than to a DOM element.
 * The role comes from the primitive in that case, not from the call site.
 */
const SURFACE_CLASS_PROPS = ["wrapperClassName", "scrimClassName"];

/**
 * The escape hatch, for an overlay that genuinely is not a dialog — a drag layer,
 * a decorative veil, anything that neither traps focus nor takes over the page.
 * There are none today; the comment is the contract for the first one.
 */
const ESCAPE_HATCH = "non-dialog-overlay:";

/**
 * The opening tag starting at `start`, or null if it never closes. Same depth
 * scanner as `select-aria-label.test.ts`: quotes are skipped whole so a `>` inside
 * a class string is inert, braces are counted so a `>` inside a prop expression
 * does not end the tag early.
 */
function openingTag(source: string, start: number): string | null {
  let depth = 0;
  let quote: string | null = null;

  for (let i = start; i < source.length; i++) {
    const ch = source[i];

    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

/** Every JSX opening tag in `source`, as [startIndex, tagText]. */
function openingTags(source: string): Array<[number, string]> {
  const tags: Array<[number, string]> = [];
  // A `<` followed by a name character. TypeScript generics (`useState<Foo>`) match
  // too and are harmless: nothing filters on them except "contains the overlay
  // class", which a generic never does.
  for (const match of source.matchAll(/<[A-Za-z][A-Za-z0-9.]*(?=[\s/>])/g)) {
    const tag = openingTag(source, match.index);
    if (tag !== null) tags.push([match.index, tag]);
  }
  return tags;
}

/** True when the tag's own `className` (string or template literal) has the class. */
function classNameCarriesOverlay(tag: string): boolean {
  // `wrapperClassName=` does not match: the capital C makes it a different token.
  const attr = /\bclassName=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g;
  for (const m of tag.matchAll(attr)) {
    if ((m[1] ?? m[2] ?? m[3] ?? "").includes(OVERLAY_CLASS)) return true;
  }
  return false;
}

interface Overlay {
  file: string;
  line: number;
  tag: string;
}

interface FileScan {
  file: string;
  /** JSX elements whose own className makes them a full-screen overlay. */
  overlays: Overlay[];
  /** Occurrences of the class the scanner could not attribute to a known shape. */
  unaccounted: number[];
  source: string;
}

function scan(): FileScan[] {
  const files = fg.sync("**/*.tsx", {
    cwd: SRC,
    ignore: ["__tests__/**", "**/*.test.tsx"],
  });

  const scans: FileScan[] = [];

  for (const rel of files) {
    const source = readFileSync(path.join(SRC, rel), "utf8");
    if (!source.includes(OVERLAY_CLASS)) continue;

    const tags = openingTags(source);
    const overlays: Overlay[] = [];
    /** Character ranges the scanner understands, for the accounting pass below. */
    const accounted: Array<[number, number]> = [];

    for (const [start, tag] of tags) {
      if (!tag.includes(OVERLAY_CLASS)) continue;

      if (classNameCarriesOverlay(tag)) {
        overlays.push({
          file: rel,
          line: source.slice(0, start).split("\n").length,
          tag,
        });
        accounted.push([start, start + tag.length]);
        continue;
      }

      // Handed to DialogSurface as a class string; the role is the primitive's.
      if (SURFACE_CLASS_PROPS.some((prop) => tag.includes(`${prop}=`))) {
        accounted.push([start, start + tag.length]);
      }
    }

    // The primitive's own default class strings live outside any JSX tag.
    if (rel === PRIMITIVE) {
      for (const prop of [...SURFACE_CLASS_PROPS, "wrapperClassName"]) {
        for (const m of source.matchAll(new RegExp(`${prop}\\s*=\\s*"[^"]*"`, "g"))) {
          accounted.push([m.index, m.index + m[0].length]);
        }
      }
    }

    const unaccounted: number[] = [];
    for (const m of source.matchAll(new RegExp(OVERLAY_CLASS, "g"))) {
      const at = m.index;
      if (!accounted.some(([from, to]) => at >= from && at < to)) unaccounted.push(at);
    }

    scans.push({ file: rel, overlays, unaccounted, source });
  }

  return scans;
}

/** The comment escape hatch, on the overlay's line or the two lines above it. */
function hasEscapeHatch(scan: FileScan, overlay: Overlay): boolean {
  const lines = scan.source.split("\n");
  return lines
    .slice(Math.max(0, overlay.line - 3), overlay.line)
    .some((l) => l.includes(ESCAPE_HATCH));
}

const scans = scan();
const overlays = scans.flatMap((s) => s.overlays);

describe("full-screen overlays are dialogs", () => {
  it("finds the overlays at all", () => {
    // A scanner that matches nothing passes everything below vacuously, so this is an
    // anti-vacuity FLOOR, not a pin — the same distinction `select-aria-label.test.ts`
    // draws ("The count is a floor, not a pin"). Pinning the file set instead would
    // make the policy test below unreachable: every file it can flag is a file the pin
    // has already rejected, so a correctly-roled hand-rolled overlay would fail here
    // with a scanner-looks-broken message, and the documented `non-dialog-overlay:`
    // escape hatch could suppress that test while never turning the suite green
    // (CAR-197 review). The floor is the primitive's own inline unsaved-changes dialog,
    // a DOM sibling of the surface rather than a DialogSurface of its own — registering
    // as a layer would make the Modal non-topmost and its own Escape branch unreachable.
    expect(overlays.length).toBeGreaterThanOrEqual(1);
    expect(overlays.some((o) => o.file === PRIMITIVE)).toBe(true);
  });

  it("accounts for every occurrence of the overlay class", () => {
    const blind = scans.flatMap((s) =>
      s.unaccounted.map(
        (at) => `${s.file}:${s.source.slice(0, at).split("\n").length}`,
      ),
    );

    expect(
      blind,
      `"${OVERLAY_CLASS}" appears here in a shape this scanner does not recognise, ` +
        `so the dialog check silently skips it. Extend the scanner rather than the class string.`,
    ).toEqual([]);
  });

  it("gives every overlay a dialog role", () => {
    const roleless = overlays
      .filter((o) => o.file !== PRIMITIVE)
      .filter((o) => !/\brole=("|'|\{")(dialog|alertdialog)\1?/.test(o.tag))
      .filter((o) => !hasEscapeHatch(scans.find((s) => s.file === o.file)!, o))
      .map((o) => `${o.file}:${o.line}`);

    expect(
      roleless,
      `a full-screen overlay with no role is invisible to assistive tech and to axe. ` +
        `Render it through DialogSurface in ${PRIMITIVE}, or mark it "${ESCAPE_HATCH} <why>".`,
    ).toEqual([]);
  });
});

/**
 * Every portal either targets a dialog surface or says why it does not (CAR-197 review).
 *
 * `useModalPortalContainer` exists because the focus trap is "everything inside the
 * surface": a child that portals to `document.body` leaves the tab cycle and becomes
 * keyboard-unreachable, and the surface's `aria-modal` additionally hides it from
 * assistive tech, all while looking perfectly correct on screen. CONVENTIONS.md called
 * that rule "adopted by every current call site" — and it was not. Guided onboarding's
 * sort menu portalled to the body, and the moment a trap went on that dialog its options
 * became mouse-only. Nothing caught it, because nothing checked.
 *
 * The exemption is real and common: a hover tooltip holds no focusable content, so the
 * trap is irrelevant to it. That is a claim about the portalled content, which no static
 * scan can verify — so the author asserts it in a comment rather than the scan inferring it.
 */
describe("portals target the dialog surface", () => {
  const BODY_PORTAL_HATCH = "body-portal:";

  /** Comments stripped, so a justification comment inside the arg list is not the arg. */
  const withoutComments = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  /**
   * The last top-level argument of the `createPortal(` call starting at `open`.
   *
   * Collects every segment rather than tracking one index, because of trailing commas:
   * `createPortal(node, target,)` ends on a blank segment, and reading that as the
   * target reports "no target" for a call that plainly has one.
   */
  function lastArgument(source: string, open: number): { text: string; at: number } | null {
    let depth = 0;
    let quote: string | null = null;
    let segmentStart = open + 1;
    const segments: Array<{ text: string; at: number }> = [];

    for (let i = open; i < source.length; i++) {
      const ch = source[i];
      if (quote) {
        if (ch === quote && source[i - 1] !== "\\") quote = null;
        continue;
      }
      // Comments are skipped DURING the walk, not stripped from the result. Prose is
      // full of parentheses and commas, and a comma in a comment sitting at argument
      // depth splits the argument list — which is exactly how the first cut of this
      // guard failed to catch the very portal it was written for: the explanatory
      // comment above that call site contained "(invisible to a screen reader),".
      if (ch === "/" && source[i + 1] === "/") {
        const nl = source.indexOf("\n", i);
        if (nl === -1) break;
        i = nl;
        continue;
      }
      if (ch === "/" && source[i + 1] === "*") {
        const end = source.indexOf("*/", i + 2);
        if (end === -1) break;
        i = end + 1;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        continue;
      }
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) {
          segments.push({ text: source.slice(segmentStart, i), at: segmentStart });
          const meaningful = segments
            .map((x) => ({ text: withoutComments(x.text).trim(), at: x.at }))
            .filter((x) => x.text);
          return meaningful[meaningful.length - 1] ?? null;
        }
      } else if (ch === "," && depth === 1) {
        segments.push({ text: source.slice(segmentStart, i), at: segmentStart });
        segmentStart = i + 1;
      }
    }
    return null;
  }

  const portals = fg
    .sync("**/*.tsx", { cwd: SRC, ignore: ["__tests__/**", "**/*.test.tsx"] })
    .flatMap((rel) => {
      const source = readFileSync(path.join(SRC, rel), "utf8");
      return [...source.matchAll(/createPortal\(/g)].map((m) => {
        const open = m.index + "createPortal".length;
        const arg = lastArgument(source, open);
        return {
          file: rel,
          line: source.slice(0, m.index).split("\n").length,
          target: arg?.text ?? "",
          // The justification is read around the TARGET, not around `createPortal(`.
          // A portalled subtree is often dozens of lines, so anchoring on the call
          // put the window nowhere near the argument the comment is about.
          targetLine: arg ? source.slice(0, arg.at).split("\n").length : 0,
          source,
        };
      });
    });

  it("finds the portals at all", () => {
    // A floor, not a pin. If the argument scanner mis-terminates, every target reads
    // empty and the policy assertion below passes over nothing.
    expect(portals.length).toBeGreaterThanOrEqual(8);
    expect(portals.filter((p) => p.target === "").map((p) => `${p.file}:${p.line}`)).toEqual([]);
  });

  it("never portals to the bare body without saying why", () => {
    const bare = portals
      .filter((p) => p.target === "document.body")
      .filter((p) => {
        const lines = p.source.split("\n");
        return !lines
          .slice(Math.max(0, p.targetLine - 4), p.targetLine + 1)
          .some((l) => l.includes(BODY_PORTAL_HATCH));
      })
      .map((p) => `${p.file}:${p.line}`);

    expect(
      bare,
      "a child portalled to document.body sits outside the focus trap and the aria-modal " +
        "boundary of any enclosing dialog. Portal to `useModalPortalContainer() ?? document.body`, " +
        `or mark it "${BODY_PORTAL_HATCH} <why this holds nothing focusable>".`,
    ).toEqual([]);
  });
});

/**
 * A dialog with no accessible name announces as just "dialog". `Modal` names itself
 * from `title` or `ariaLabel`; `DialogSurface` from `labelledBy` or `label`. Neither
 * can enforce "at least one" in the type system without making the common call site
 * worse, so it is enforced here.
 */
describe("every dialog call site names itself", () => {
  const NAMED_BY: Record<string, string[]> = {
    Modal: ["title", "ariaLabel"],
    DialogSurface: ["labelledBy", "label"],
  };

  const sites = fg
    .sync("**/*.tsx", { cwd: SRC, ignore: ["__tests__/**", "**/*.test.tsx"] })
    .flatMap((rel) => {
      const source = readFileSync(path.join(SRC, rel), "utf8");
      return Object.keys(NAMED_BY).flatMap((component) =>
        [...source.matchAll(new RegExp(`<${component}(?![A-Za-z0-9_])`, "g"))]
          .map((m) => ({
            file: rel,
            component,
            line: source.slice(0, m.index).split("\n").length,
            tag: openingTag(source, m.index),
          }))
          .filter((s): s is typeof s & { tag: string } => s.tag !== null),
      );
    });

  it("finds the call sites at all", () => {
    // A floor, not a pin: 13 dialogs were migrated onto these two components and
    // the primitive renders one itself.
    expect(sites.length).toBeGreaterThanOrEqual(13);
    expect(new Set(sites.map((s) => s.component))).toEqual(new Set(Object.keys(NAMED_BY)));
  });

  it("extracts plausible opening tags", () => {
    // If the depth scanner mis-terminates, every assertion below goes meaningless.
    // Both components take `isOpen`, so a tag without it means the scan is wrong.
    const malformed = sites.filter((s) => !/\bisOpen\b/.test(s.tag));
    expect(malformed.map((s) => `${s.file}:${s.line}`)).toEqual([]);
  });

  it("passes a name to every one", () => {
    const unnamed = sites
      .filter((s) => !NAMED_BY[s.component].some((prop) => new RegExp(`\\b${prop}=`).test(s.tag)))
      .map((s) => `${s.file}:${s.line} <${s.component}>`);

    expect(unnamed).toEqual([]);
  });
});
