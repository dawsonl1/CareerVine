/**
 * The baseline-ratchet algebra behind check-conventions.mjs's client-state
 * guards (CAR-190).
 *
 * A ratchet is what you ship when a convention is right but the tree is not
 * clean yet, and it is strictly better than the alternative the CAR-190 ticket
 * proposed (a warning listing offenders). A warning exits 0, and an
 * unenforced convention decays: CAR-154's helper reached 6 files and CAR-158's
 * reached 1 before anyone noticed. A ratchet fails, so new code cannot
 * regress, while the honest size of the existing debt stays visible in the
 * baseline literal rather than hidden behind a green check.
 *
 * Both directions matter, and the second is the one people forget:
 *
 *   an offender absent from the baseline  → violation. This is the guard.
 *   a baselined site that no longer offends → violation, saying to delete the
 *     line. This is what stops ground being given back, and it is what keeps
 *     the baseline an inventory rather than a list of things that used to be
 *     true.
 *
 * Lives in its own module so the algebra is unit-testable directly. The
 * detectors are tested through the script as a subprocess against a fixture
 * tree (see src/__tests__/check-conventions.test.ts), but that route cannot
 * exercise the stale-entry direction: the fixture contains none of the real
 * baselined files, so every entry would read as stale at once.
 *
 * `presentFiles` is why: the stale check applies only to files the scan
 * actually looked at. A file absent from the checkout cannot violate anything,
 * and without this the guard would fail on any partial tree — which is exactly
 * what the fixture is.
 */

/**
 * Named ratchet: `found` is { file: [{ name, line }] }, `baseline` is
 * { file: [name] }.
 *
 * @param {Record<string, Array<{name: string, line: number}>>} found
 * @param {Record<string, string[]>} baseline
 * @param {Set<string>} presentFiles files the scan visited
 * @param {string} where human-readable location of the baseline literal
 * @returns {string[]} violation lines
 */
export function diffNamedRatchet(found, baseline, presentFiles, where) {
  const violations = [];

  for (const file of Object.keys(found).sort()) {
    const allowed = new Set(baseline[file] ?? []);
    for (const { name, line } of found[file]) {
      if (!allowed.has(name)) violations.push(`${file}:${line}: ${name}`);
    }
  }

  for (const file of Object.keys(baseline).sort()) {
    if (!presentFiles.has(file)) continue;
    const still = new Set((found[file] ?? []).map((f) => f.name));
    for (const name of baseline[file]) {
      if (!still.has(name)) {
        violations.push(`${file}: ${name} no longer violates — delete it from the baseline in ${where}`);
      }
    }
  }

  return violations;
}

/**
 * Counted ratchet, for a violation with no name to key on: `found` and
 * `baseline` are both { file: count }.
 *
 * @param {Record<string, number>} found
 * @param {Record<string, number>} baseline
 * @param {Set<string>} presentFiles files the scan visited
 * @param {string} where human-readable location of the baseline literal
 * @param {string} unit what is being counted, for the message
 * @returns {string[]} violation lines
 */
export function diffCountRatchet(found, baseline, presentFiles, where, unit) {
  const violations = [];

  for (const file of Object.keys(found).sort()) {
    const allowed = baseline[file] ?? 0;
    if (found[file] > allowed) {
      violations.push(`${file}: ${found[file]} ${unit}, baseline is ${allowed}`);
    }
  }

  for (const file of Object.keys(baseline).sort()) {
    if (!presentFiles.has(file)) continue;
    const actual = found[file] ?? 0;
    if (actual < baseline[file]) {
      violations.push(`${file}: down to ${actual} — lower its baseline entry in ${where} to ${actual}`);
    }
  }

  return violations;
}
