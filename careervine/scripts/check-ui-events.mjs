#!/usr/bin/env node
/**
 * CI guard (CAR-145 / F18): the raw `careervine:` event-bus string literal must
 * live only in the typed ui-events module. Every other call site
 * dispatches/subscribes through `emitUiEvent`/`onUiEvent` from
 * `@/lib/ui-events`, so a stray literal means an un-migrated call site or a
 * typo that would silently no-op (the wrong string never matches a listener).
 *
 * (CAR-150 converted `inbox-shell.tsx`, the last exempt call site, so only the
 * module and its test carry the raw literal now.)
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "src";
const NEEDLE = "careervine:";
const EXEMPT = new Set([
  "src/lib/ui-events.ts",
  "src/__tests__/ui-events.test.ts",
]);
const EXTENSIONS = [".ts", ".tsx"];

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
}

const files = [];
walk(ROOT, files);

const violations = [];
for (const file of files) {
  const rel = file.split("\\").join("/");
  if (EXEMPT.has(rel)) continue;
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (line.includes(NEEDLE)) violations.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
}

if (violations.length > 0) {
  console.error(
    "✖ Raw `careervine:` string literal found outside the typed ui-events module.\n" +
      "  Use UI_EVENTS + emitUiEvent/onUiEvent from '@/lib/ui-events' instead.\n",
  );
  for (const v of violations) console.error("  " + v);
  process.exit(1);
}

console.log(
  `✓ ui-events guard: no stray \`careervine:\` literals in ${files.length} scanned files.`,
);
