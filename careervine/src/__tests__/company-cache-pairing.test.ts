import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * CAR-278. Two caches describe the same rows from different angles: the company
 * DETAIL roster (`invalidateCompanyScopes`) and the /companies LIST
 * (`refreshCompaniesList`). A write that contradicts one almost always
 * contradicts the other, and both are unmounted at the moment it happens, so
 * neither can notice on its own.
 *
 * They had drifted apart before this was written. Ten call sites invalidated the
 * roster; three refreshed the list. Logging a call, sending an email, excluding
 * a timeline entry, editing a contact and adding a discovery candidate all left
 * /companies showing a traction chip, a count or a lead name the user's own
 * action had just falsified — for the whole TTL, which CAR-278 tripled.
 *
 * So the pairing is asserted rather than remembered. Adding a roster
 * invalidation to a new write site now fails here until the list is considered
 * too, which is the moment to think about it rather than three tickets later.
 */

const ROOT = path.resolve(__dirname, "..");
const SCOPES_CALL = "invalidateCompanyScopes()";
const LIST_CALL = "refreshCompaniesList(";

/**
 * Write sites that genuinely change a roster and genuinely change NOTHING the
 * /companies card renders. Each needs a reason, because "it seemed unrelated"
 * is how the drift above happened.
 */
const UNPAIRED: Record<string, string> = {
  "components/contacts/contact-profile-card.tsx":
    "one of its two sites edits an email address; no /companies field is derived " +
    "from one (CompanyRosterEntry carries no email, and the lead is a name)",
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("roster and list caches are invalidated together", () => {
  const callers = sourceFiles(ROOT)
    .filter((f) => fs.readFileSync(f, "utf8").includes(SCOPES_CALL))
    // The cache module itself defines the function; it is not a call site.
    .filter((f) => !f.endsWith("company-detail-cache.ts"))
    .map((f) => path.relative(ROOT, f));

  it("finds the write sites at all, so an empty sweep cannot pass", () => {
    // The detector is the thing most likely to be wrong here: a rename, a moved
    // directory or a bad glob turns this whole file into a no-op that reports
    // success. Measured at 9 when written.
    expect(callers.length).toBeGreaterThanOrEqual(8);
  });

  it("pairs every one of them", () => {
    const missing = callers.filter((rel) => {
      if (rel in UNPAIRED) return false;
      return !fs.readFileSync(path.join(ROOT, rel), "utf8").includes(LIST_CALL);
    });
    expect(
      missing,
      `these files drop the cached company roster but leave the /companies list holding rows ` +
        `their own write contradicted. Add refreshCompaniesList() beside ` +
        `invalidateCompanyScopes(), or add the file to UNPAIRED with the reason no /companies ` +
        `field is derived from what it wrote.`,
    ).toEqual([]);
  });

  it("keeps the exemption list honest", () => {
    // An exemption for a file that no longer invalidates anything is a stale
    // licence sitting there waiting to excuse a future site.
    for (const rel of Object.keys(UNPAIRED)) {
      expect(callers, `${rel} is exempted but no longer calls ${SCOPES_CALL}`).toContain(rel);
    }
  });
});
