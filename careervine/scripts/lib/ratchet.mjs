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

  // A MULTISET, not a set. Names are not unique: check (j) labels an unnamed
  // `useEffect` with the enclosing const, falling back to the literal
  // "useEffect", and a component with two of them collapses to one label. Under
  // a Set the second offender matched the first's entry and passed free —
  // reintroducing exactly the "trade a fixed violation for a fresh one" hole
  // that choosing named over counted was supposed to close. One found row
  // consumes one baseline slot; leftovers on either side are violations.
  for (const file of Object.keys(found).sort()) {
    const unclaimed = [...(baseline[file] ?? [])];
    for (const { name, line } of found[file]) {
      const slot = unclaimed.indexOf(name);
      if (slot === -1) violations.push(`${file}:${line}: ${name}`);
      else unclaimed.splice(slot, 1);
    }
  }

  for (const file of Object.keys(baseline).sort()) {
    if (!presentFiles.has(file)) continue;
    // Same accounting from the other side: count how many of each name remain,
    // so a baseline listing a name twice against one surviving offender still
    // reports the one that was given back.
    const remaining = [...(found[file] ?? []).map((f) => f.name)];
    for (const name of baseline[file]) {
      const slot = remaining.indexOf(name);
      if (slot === -1) {
        violations.push(`${file}: ${name} no longer violates — delete it from the baseline in ${where}`);
      } else {
        remaining.splice(slot, 1);
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
    if (actual === 0) {
      // Say DELETE, not "lower it to 0". A literal `: 0` entry authorizes
      // nothing, but it is dead weight that survives the file's own deletion
      // (see presentFiles above) and inflates a baseline whose whole job is to
      // be an honest inventory. Drop-to-zero is also the common case: a ticket
      // that migrates a file's last offender hits this, not the partial branch.
      violations.push(`${file}: no longer offends — delete its baseline entry in ${where}`);
    } else if (actual < baseline[file]) {
      violations.push(`${file}: down to ${actual} — lower its baseline entry in ${where} to ${actual}`);
    }
  }

  return violations;
}
