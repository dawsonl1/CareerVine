/**
 * CAR-193: every color token a utility class names must exist in `@theme inline`.
 *
 * Tailwind v4 only emits a utility for a color token declared in the `@theme`
 * block. A class naming an undeclared token is not an error anywhere in the
 * pipeline — it is simply not a utility, so it compiles to nothing, the element
 * renders transparent, and the failure is invisible wherever the backdrop
 * already happens to be the intended color. That is exactly how `bg-surface`
 * survived across ~24 call sites: `--md-surface` existed, `--color-surface`
 * never did, and every site sat on a `bg-background` (#ffffff) shell that
 * painted the same white the utility was meant to paint.
 *
 * The guard is scoped to the app's own M3 vocabulary — the `--md-*` palette in
 * `:root`. Those names are what the design system invites you to write as
 * `bg-<name>` / `text-<name>`, so a `--md-x` that source code uses as a utility
 * but `@theme` never re-exports is always the bug above. Tailwind's built-in
 * palette (`bg-white`, `text-red-500`) is out of scope and needs no declaration.
 *
 * Pure string scan over source text — fast, no module execution, no build.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fg from "fast-glob";
import { describe, it, expect } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "..");
const globalsCss = readFileSync(path.join(srcDir, "app/globals.css"), "utf8");

/** Utility prefixes that resolve their value from a `--color-*` theme token. */
const COLOR_UTILITY_PREFIXES = [
  "bg", "text", "border", "ring", "from", "via", "to", "fill", "stroke",
  "divide", "outline", "shadow", "accent", "caret", "decoration", "placeholder",
];

function block(css: string, opener: RegExp): string {
  const start = css.search(opener);
  if (start === -1) return "";
  const end = css.indexOf("\n}", start);
  return css.slice(start, end === -1 ? undefined : end);
}

/** `--md-*` entries in `:root` whose value is a color (skips shape/elevation). */
function paletteTokens(): string[] {
  const root = block(globalsCss, /^:root\s*\{/m);
  const names: string[] = [];
  for (const [, name, value] of root.matchAll(/--md-([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    if (/#[0-9a-f]{3,8}|\brgba?\(|\bhsla?\(|\boklch\(|\bcolor-mix\(/i.test(value)) names.push(name);
  }
  return names;
}

/** Token names re-exported as Tailwind utilities via `--color-*`. */
function themeTokens(): Set<string> {
  const theme = block(globalsCss, /@theme\s+inline\s*\{/);
  return new Set([...theme.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]));
}

/** Every `<prefix>-<token>` occurrence in source, for the palette names given. */
function usagesOf(tokens: string[]): Map<string, string[]> {
  const files = fg.sync("**/*.{ts,tsx}", {
    cwd: srcDir,
    absolute: true,
    ignore: ["**/__tests__/**", "**/*.d.ts"],
  });
  // Boundaries stop `surface` from matching inside `surface-container`, and stop
  // a prefix from matching mid-word (e.g. the `to-` in `auto-`).
  const pattern = new RegExp(
    `(?<![a-zA-Z0-9_-])(?:${COLOR_UTILITY_PREFIXES.join("|")})-(${tokens.join("|")})(?![a-zA-Z0-9_-])`,
    "g",
  );
  const found = new Map<string, string[]>();
  for (const file of files) {
    for (const [, token] of readFileSync(file, "utf8").matchAll(pattern)) {
      const rel = path.relative(srcDir, file);
      const at = found.get(token);
      if (at) { if (!at.includes(rel)) at.push(rel); } else { found.set(token, [rel]); }
    }
  }
  return found;
}

describe("theme tokens (CAR-193)", () => {
  it("declares --color-surface, so bg-surface actually emits CSS", () => {
    expect(
      themeTokens().has("surface"),
      "globals.css lost --color-surface from @theme inline. Every bg-surface in the app silently stops emitting CSS and renders transparent.",
    ).toBe(true);
  });

  it("re-exports every --md-* color that source code uses as a utility", () => {
    const palette = paletteTokens();
    expect(palette.length).toBeGreaterThan(10);

    const declared = themeTokens();
    const used = usagesOf(palette);
    expect(used.size, "scan found no palette utilities at all — the regex or the glob broke").toBeGreaterThan(5);

    const missing = [...used.entries()]
      .filter(([token]) => !declared.has(token))
      .map(([token, files]) => `${token} (used in ${files.slice(0, 3).join(", ")}${files.length > 3 ? `, +${files.length - 3} more` : ""})`);

    expect(
      missing,
      "These tokens are used as Tailwind utilities but are not declared in globals.css's @theme inline block, so they compile to nothing and render transparent. Add `--color-<name>: var(--md-<name>);`.",
    ).toEqual([]);
  });
});
