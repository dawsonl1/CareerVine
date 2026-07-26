/**
 * Every `<Select>` and `<MonthYearPicker>` carries an accessible name (CAR-201).
 *
 * Both render their trigger as a `<button>`. A visible `<label>` cannot be associated
 * with a button, and `labelClasses` in `lib/form-styles.ts` emits no `htmlFor`, so the
 * trigger's accessible name is its own text content — which once a value is chosen
 * *is the value*. A screen reader user on the follow-up-frequency field heard "No
 * follow-up, button, collapsed" with no way to tell which field they were on. WCAG
 * 4.1.2, Level A.
 *
 * This is a source scan rather than a render test because the failure is invisible
 * three ways over: nothing on screen changes, no existing render test asserts a name,
 * and a new call site is exactly where it recurs. 17 sites had gone unlabelled.
 *
 * The opening tag is found by brace/quote depth rather than by regex, so a `>` inside
 * a prop string or a nested `{cond ? <A/> : <B/>}` in an options array does not end the
 * tag early — both occur at real call sites here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fg from "fast-glob";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..");

/** Components whose trigger is a button with no associable label. */
const GUARDED = ["Select", "MonthYearPicker"];

/**
 * The files that *define* these components, plus tests. `state-select.tsx` is not
 * exempt: it wraps `Select` and has to pass a name down like any other caller.
 */
const EXEMPT = ["components/ui/select.tsx", "components/ui/month-year-picker.tsx"];

/**
 * The opening tag starting at `start`, or null if it never closes.
 *
 * Quotes are skipped whole so a `>` or a brace inside a string is inert; braces are
 * counted so a `>` inside a prop expression does not read as the end of the tag.
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

interface Site {
  file: string;
  component: string;
  line: number;
  tag: string;
}

function findSites(): Site[] {
  const files = fg.sync("**/*.tsx", {
    cwd: SRC,
    ignore: ["__tests__/**", "**/*.test.tsx"],
  });

  const sites: Site[] = [];

  for (const rel of files) {
    if (EXEMPT.includes(rel)) continue;
    const source = readFileSync(path.join(SRC, rel), "utf8");

    for (const component of GUARDED) {
      // The negative lookahead stops `<SelectOption` matching as `<Select`.
      const opener = new RegExp(`<${component}(?![A-Za-z0-9_])`, "g");
      for (const match of source.matchAll(opener)) {
        const tag = openingTag(source, match.index);
        if (tag === null) continue;
        sites.push({
          file: rel,
          component,
          line: source.slice(0, match.index).split("\n").length,
          tag,
        });
      }
    }
  }
  return sites;
}

describe("Select and MonthYearPicker accessible names", () => {
  const sites = findSites();

  it("finds the call sites at all", () => {
    // A scanner that matches nothing passes every assertion below vacuously. The
    // count is a floor, not a pin: adding a Select should not fail this test, and
    // dropping below it should. 20 when CAR-201 landed; 19 since CAR-207 turned
    // /interactions into a redirect, taking its interaction-type Select with it.
    expect(sites.length).toBeGreaterThanOrEqual(19);
    expect(new Set(sites.map((s) => s.component))).toEqual(new Set(GUARDED));
  });

  it("extracts plausible opening tags", () => {
    // If the depth scanner ever mis-terminates, the tags go junk and every ariaLabel
    // assertion turns meaningless. Every one of these components takes `value`, so a
    // tag without it means the scan, not the call site, is wrong.
    const malformed = sites.filter((s) => !/\bvalue=/.test(s.tag));
    expect(malformed.map((s) => `${s.file}:${s.line}`)).toEqual([]);
  });

  it("gives every call site an accessible name", () => {
    const unlabelled = sites
      .filter((s) => !/\bariaLabel=/.test(s.tag))
      .map((s) => `${s.file}:${s.line} <${s.component}>`);

    expect(unlabelled).toEqual([]);
  });

  it("never passes an empty accessible name", () => {
    // `ariaLabel=""` satisfies the check above and names nothing.
    const empty = sites
      .filter((s) => /\bariaLabel=(""|''|\{""\}|\{''\}|\{``\})/.test(s.tag))
      .map((s) => `${s.file}:${s.line}`);

    expect(empty).toEqual([]);
  });
});
