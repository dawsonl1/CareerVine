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
 * A baseline is NAMED, not counted: one found row consumes one slot, so a
 * repeated name cannot ride another's entry (diffNamedRatchet below carries
 * the multiset accounting that makes that hold). A site with no declaration to
 * name is keyed by its shape instead — an inline JSX handler by its prop plus
 * a hash of its body. The prop alone will not do: every inline handler in a
 * file collapses to `onClick`, which quietly turns a named ratchet back into a
 * counted one and lets a fix be traded for a fresh violation in the same file.
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
 *
 * ── Reading a baseline figure ──
 *
 * A published count is a property of the DETECTOR, not of the codebase, so
 * treat any figure quoted outside the literal as provisional. The
 * double-submit list is the worked example: published at 35, corrected to 54
 * once CAR-190 removed five blind spots, then to 129 once CAR-208 found three
 * more — a handler-name filter that inspected `handleAdd` while ignoring an
 * identical `addContact`, inline JSX handlers as an entire invisible class,
 * and non-named import shapes that bound a seam the scan could not resolve.
 * The literal in check-conventions.mjs is the count; a number in prose is a
 * claim about a detector that has already been wrong twice.
 *
 * The figure is also deliberately an OVER-count, and reading it as that many
 * live bugs would be wrong. A callee is judged a write by its verb against a
 * denylist of read verbs, so a pure helper whose name does not look like a
 * read counts as a write, and a handler one hop from a real write counts
 * alongside the helper it calls. The asymmetry is chosen: over-inclusion costs
 * a baseline line, under-inclusion costs a live bug. Tuning it the other way
 * is how this breaks — adding `fetch` to the read verbs, the safest-looking
 * addition on offer, silently un-flagged the most destructive handler the list
 * then named, whose write runs through a helper called `fetchStepWithRetry`.
 * Read the READ_VERB note in check-conventions.mjs before touching that list.
 *
 * Baselines shrink, and that is the point: CAR-207 drained six entries from
 * that list, and CAR-217 a seventh — the twin of a toggle it was adding,
 * because guarding the new one while baselining the old would have frozen a
 * second copy of the same bug beside a fixed one. Draining the rest is a
 * mechanical sweep of its own;
 * the contract here is only that the list can never grow back.
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
 * NO CONSUMER IN check-conventions.mjs SINCE CAR-208, which deleted the overlay
 * check that was the only counted one. Kept rather than deleted because it is
 * the tested half of a two-shape contract and the next nameless violation needs
 * it ready; check (d)'s hand-rolled count ratchet is deliberately NOT routed
 * through it, since (d) treats an under-baseline count as a note that exits 0
 * rather than as a violation. Delete both this and its tests if that stops
 * being worth the shelf space.
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
