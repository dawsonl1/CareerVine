/**
 * CAR-194: no unlayered universal-selector rule in globals.css.
 *
 * `@import "tailwindcss"` puts every Tailwind rule into a cascade layer
 * (`theme`, `base`, `components`, `utilities`). In the CSS cascade an UNLAYERED
 * rule beats every layered rule regardless of selector specificity, so a single
 * top-level declaration in globals.css silently outranks the entire utility
 * layer. Nothing errors; the utility simply stops winning.
 *
 * That is how `* { border-color: var(--md-outline-variant) }` killed all 447
 * `border-<color>` utilities app-wide, including Tailwind's own
 * `border-red-500` and every `focus:border-primary` focus ring. The clearest
 * symptom was the app-wide spinner: `border-primary border-t-transparent`
 * collapsed to a uniform gray ring with no contrast gap, so it span invisibly.
 *
 * Scope: the universal selector specifically. This file also holds top-level
 * opt-in helpers (`.state-layer`, `.animate-*`, `.onboarding-cue`) which are
 * unlayered but harmless — they only style elements that ask for them by name,
 * so a collision with a utility would be visible to whoever wrote it. `*` is
 * the dangerous shape because it lands on every element in the app, including
 * ones carrying utilities for the very property it sets.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.resolve(here, "../app/globals.css");

/** Comments are stripped up front so a brace or `*` inside one cannot corrupt the scan. */
const css = readFileSync(cssPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

type Rule = { selector: string; body: string };

/**
 * Rules at brace depth 0. Anything nested inside `@layer { ... }` (or any other
 * block) is skipped wholesale, which is exactly what we want: layered rules are
 * safe by construction.
 */
function topLevelRules(source: string): Rule[] {
  const rules: Rule[] = [];
  let i = 0;
  let preludeStart = 0;

  while (i < source.length) {
    if (source[i] === ";") {
      i += 1;
      preludeStart = i;
      continue;
    }

    if (source[i] === "{") {
      const selector = source.slice(preludeStart, i).trim();
      let depth = 1;
      let j = i + 1;
      while (j < source.length && depth > 0) {
        if (source[j] === "{") depth += 1;
        else if (source[j] === "}") depth -= 1;
        j += 1;
      }
      rules.push({ selector, body: source.slice(i + 1, j - 1) });
      i = j;
      preludeStart = i;
      continue;
    }

    i += 1;
  }

  return rules;
}

/** True for a selector that targets every element, e.g. `*` or `*, ::before`. */
function isUniversal(selector: string): boolean {
  return selector
    .split(",")
    .some((part) => part.trim().replace(/::?[a-z-]+(\([^)]*\))?/g, "").trim() === "*");
}

describe("globals.css cascade layering (CAR-194)", () => {
  const rules = topLevelRules(css);

  it("the scanner actually finds rules, including a layer block", () => {
    // Without this the guards below could pass vacuously on a parse failure.
    expect(rules.length).toBeGreaterThan(5);
    expect(
      rules.some((r) => r.selector.startsWith("@layer")),
      "expected globals.css to contain an @layer block",
    ).toBe(true);
  });

  it("keeps the default border color inside a layer", () => {
    const layered = rules.find(
      (r) => r.selector.startsWith("@layer") && /border-color\s*:/.test(r.body),
    );
    expect(
      layered,
      "the `* { border-color }` default is no longer inside an @layer block. Unlayered, it outranks every Tailwind utility and silently kills all border-<color> classes app-wide: spinners lose their contrast gap and focus:border-primary stops rendering. Wrap it in `@layer base { ... }`.",
    ).toBeDefined();
  });

  it("has no unlayered universal-selector rule", () => {
    const offenders = rules
      .filter((r) => !r.selector.startsWith("@") && isUniversal(r.selector))
      .map((r) => `${r.selector.replace(/\s+/g, " ")} { ${r.body.trim().replace(/\s+/g, " ").slice(0, 50)} }`);

    expect(
      offenders,
      "A `*` rule outside any @layer beats every layered Tailwind rule regardless of specificity, so it silently overrides the utilities for whatever properties it sets, on every element in the app. Move it into `@layer base { ... }`.",
    ).toEqual([]);
  });
});
