/**
 * One primary email per contact (CAR-279) — the data layer's half.
 *
 * `is_primary` is where mail goes: resolveRecipient, the outreach queue, the
 * profile card, and the AI follow-up generator, which filters on it with NO
 * fallback and silently skips a contact that has none. Three things could
 * produce that state before this change: a re-add from the extension filed the
 * new address as secondary, deleting the primary in the UI left zero primaries,
 * and the "Preferred" checkbox never touched the flag at all.
 *
 * Assertions are on the resulting row set, not the call sequence — a writer that
 * issues plausible statements in an order that leaves two primaries is exactly
 * the bug.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { FakeEmailTable } from "./helpers/fake-contact-emails";
import {
  applyImportedPrimaryEmail,
  replaceContactEmails,
  deleteContactEmail,
  setPrimaryEmail,
  bestPrimaryEmailRow,
} from "@/lib/data/contacts";

const CONTACT = 7;
let table: FakeEmailTable;
const opts = () => ({ client: table.client() });

beforeEach(() => {
  table = new FakeEmailTable();
});

describe("applyImportedPrimaryEmail — re-adding from the extension (CAR-279)", () => {
  it("promotes a newly typed address over the one already on file", async () => {
    table.seed(CONTACT, [{ email: "old@acme.com", is_primary: true }]);

    await applyImportedPrimaryEmail(CONTACT, "new@acme.com", opts());

    expect(table.primaryOf(CONTACT)?.email).toBe("new@acme.com");
    expect(table.of(CONTACT).filter((r) => r.is_primary)).toHaveLength(1);
  });

  it("KEEPS the displaced address, demoted", async () => {
    // Past correspondence is linked to contacts by address, and a reply from the
    // old one still has to resolve to this contact (CAR-227).
    table.seed(CONTACT, [{ email: "old@acme.com", is_primary: true }]);

    await applyImportedPrimaryEmail(CONTACT, "new@acme.com", opts());

    expect(table.addressesOf(CONTACT).sort()).toEqual(["new@acme.com", "old@acme.com"]);
    expect(table.of(CONTACT).find((r) => r.email === "old@acme.com")?.is_primary).toBe(false);
  });

  it("deletes a displaced address that had bounced", async () => {
    table.seed(CONTACT, [{ email: "dead@acme.com", is_primary: true, bounced_at: "2026-07-01T00:00:00Z" }]);

    await applyImportedPrimaryEmail(CONTACT, "new@acme.com", opts());

    expect(table.addressesOf(CONTACT)).toEqual(["new@acme.com"]);
    expect(table.primaryOf(CONTACT)?.email).toBe("new@acme.com");
  });

  it("promotes an address the contact already has instead of duplicating it", async () => {
    table.seed(CONTACT, [
      { email: "work@acme.com", is_primary: true },
      { email: "personal@gmail.com" },
    ]);

    await applyImportedPrimaryEmail(CONTACT, "personal@gmail.com", opts());

    expect(table.addressesOf(CONTACT)).toHaveLength(2);
    expect(table.primaryOf(CONTACT)?.email).toBe("personal@gmail.com");
  });

  it("clears the bounce flag when the human types that address in again", async () => {
    // Promotion would otherwise be a lie: the send path refuses a contact whose
    // addresses have all bounced, so this would be a primary nobody can use.
    table.seed(CONTACT, [{ email: "dead@acme.com", is_primary: true, bounced_at: "2026-07-01T00:00:00Z" }]);

    const result = await applyImportedPrimaryEmail(CONTACT, "dead@acme.com", opts());

    expect(result.unbounced).toBe(true);
    expect(table.primaryOf(CONTACT)).toMatchObject({ email: "dead@acme.com", bounced_at: null });
  });

  it("matches case-insensitively, the way the DB normalizes", async () => {
    table.seed(CONTACT, [{ email: "jane@acme.com", is_primary: true }]);

    await applyImportedPrimaryEmail(CONTACT, "  Jane@ACME.com ", opts());

    expect(table.addressesOf(CONTACT)).toEqual(["jane@acme.com"]);
  });

  it("is the first address when the contact has none", async () => {
    await applyImportedPrimaryEmail(CONTACT, "first@acme.com", opts());

    expect(table.primaryOf(CONTACT)?.email).toBe("first@acme.com");
  });

  it("sweeps other bounced addresses while keeping live ones", async () => {
    table.seed(CONTACT, [
      { email: "dead@acme.com", bounced_at: "2026-07-01T00:00:00Z" },
      { email: "live@acme.com", is_primary: true },
    ]);

    await applyImportedPrimaryEmail(CONTACT, "new@acme.com", opts());

    expect(table.addressesOf(CONTACT).sort()).toEqual(["live@acme.com", "new@acme.com"]);
  });
});

describe("replaceContactEmails — the UI's save path (CAR-279)", () => {
  it("leaves an untouched address's provenance and bounce flag alone", async () => {
    // The regression: the old delete-all/re-add loop rewrote every row through a
    // writer that takes neither column, so one save relabelled a scraped address
    // as hand-entered and un-bounced a dead one.
    table.seed(CONTACT, [
      { email: "primary@acme.com", is_primary: true, source: "verified" },
      { email: "guessed@acme.com", source: "pattern_guessed", bounced_at: "2026-06-01T00:00:00Z" },
    ]);
    const before = table.of(CONTACT).map((r) => r.id);

    await replaceContactEmails(
      CONTACT,
      [
        { email: "primary@acme.com", is_primary: true },
        { email: "guessed@acme.com" },
      ],
      opts(),
    );

    expect(table.of(CONTACT).map((r) => r.id)).toEqual(before);
    expect(table.of(CONTACT).find((r) => r.email === "guessed@acme.com")).toMatchObject({
      source: "pattern_guessed",
      bounced_at: "2026-06-01T00:00:00Z",
    });
    expect(table.of(CONTACT).find((r) => r.email === "primary@acme.com")?.source).toBe("verified");
  });

  it("hands primary to a survivor when the primary row is removed", async () => {
    table.seed(CONTACT, [
      { email: "gone@acme.com", is_primary: true },
      { email: "kept@acme.com" },
    ]);

    await replaceContactEmails(CONTACT, [{ email: "kept@acme.com" }], opts());

    expect(table.addressesOf(CONTACT)).toEqual(["kept@acme.com"]);
    expect(table.primaryOf(CONTACT)?.email).toBe("kept@acme.com");
  });

  it("moves primary onto the entry the form flagged", async () => {
    table.seed(CONTACT, [
      { email: "first@acme.com", is_primary: true },
      { email: "second@acme.com" },
    ]);

    await replaceContactEmails(
      CONTACT,
      [{ email: "first@acme.com" }, { email: "second@acme.com", is_primary: true }],
      opts(),
    );

    expect(table.primaryOf(CONTACT)?.email).toBe("second@acme.com");
    expect(table.of(CONTACT).filter((r) => r.is_primary)).toHaveLength(1);
  });

  it("keeps the incumbent primary when the form flags nothing", async () => {
    table.seed(CONTACT, [
      { email: "first@acme.com" },
      { email: "second@acme.com", is_primary: true },
    ]);

    await replaceContactEmails(
      CONTACT,
      [{ email: "first@acme.com" }, { email: "second@acme.com" }, { email: "third@acme.com" }],
      opts(),
    );

    expect(table.primaryOf(CONTACT)?.email).toBe("second@acme.com");
  });

  it("gives a brand-new list exactly one primary even with none flagged", async () => {
    await replaceContactEmails(CONTACT, [{ email: "a@acme.com" }, { email: "b@acme.com" }], opts());

    expect(table.of(CONTACT).filter((r) => r.is_primary)).toHaveLength(1);
  });

  it("skips blanks and collapses duplicates", async () => {
    // `contact_emails_contact_email_idx` would reject the second copy, and the
    // form can hold the same address twice.
    await replaceContactEmails(
      CONTACT,
      [{ email: "  " }, { email: "Dup@acme.com" }, { email: "dup@acme.com", is_primary: true }],
      opts(),
    );

    expect(table.addressesOf(CONTACT)).toEqual(["dup@acme.com"]);
    expect(table.primaryOf(CONTACT)?.email).toBe("dup@acme.com");
  });

  it("clears the list when every address is removed", async () => {
    table.seed(CONTACT, [{ email: "only@acme.com", is_primary: true }]);

    await replaceContactEmails(CONTACT, [], opts());

    expect(table.of(CONTACT)).toEqual([]);
  });

  it("does not touch another contact's addresses", async () => {
    table.seed(CONTACT, [{ email: "mine@acme.com", is_primary: true }]);
    table.seed(99, [{ email: "theirs@acme.com", is_primary: true }]);

    await replaceContactEmails(CONTACT, [{ email: "new@acme.com" }], opts());

    expect(table.addressesOf(99)).toEqual(["theirs@acme.com"]);
    expect(table.primaryOf(99)?.is_primary).toBe(true);
  });
});

describe("deleteContactEmail (CAR-279)", () => {
  it("promotes the best-ranked survivor when the primary goes", async () => {
    table.seed(CONTACT, [
      { email: "gone@acme.com", is_primary: true },
      { email: "dead@acme.com", bounced_at: "2026-06-01T00:00:00Z" },
      { email: "live@acme.com" },
    ]);
    const doomed = table.of(CONTACT)[0].id;

    const { promotedId } = await deleteContactEmail(CONTACT, doomed, opts());

    expect(table.primaryOf(CONTACT)?.email).toBe("live@acme.com");
    expect(promotedId).toBe(table.primaryOf(CONTACT)?.id);
  });

  it("leaves the primary alone when a secondary goes", async () => {
    table.seed(CONTACT, [
      { email: "primary@acme.com", is_primary: true },
      { email: "secondary@acme.com" },
    ]);
    const secondary = table.of(CONTACT)[1].id;

    await deleteContactEmail(CONTACT, secondary, opts());

    expect(table.primaryOf(CONTACT)?.email).toBe("primary@acme.com");
  });

  it("promotes nothing when the last address goes", async () => {
    table.seed(CONTACT, [{ email: "only@acme.com", is_primary: true }]);

    const { promotedId } = await deleteContactEmail(CONTACT, table.of(CONTACT)[0].id, opts());

    expect(promotedId).toBeNull();
    expect(table.of(CONTACT)).toEqual([]);
  });
});

describe("setPrimaryEmail (CAR-279)", () => {
  it("promotes by address, case-insensitively, and demotes the old one", async () => {
    table.seed(CONTACT, [
      { email: "old@acme.com", is_primary: true },
      { email: "new@acme.com" },
    ]);

    await setPrimaryEmail(CONTACT, { address: "NEW@acme.com" }, opts());

    expect(table.primaryOf(CONTACT)?.email).toBe("new@acme.com");
    expect(table.of(CONTACT).filter((r) => r.is_primary)).toHaveLength(1);
  });

  it("refuses an address the contact does not have", async () => {
    table.seed(CONTACT, [{ email: "old@acme.com", is_primary: true }]);

    await expect(setPrimaryEmail(CONTACT, { address: "stranger@acme.com" }, opts())).rejects.toThrow(
      /not one of this contact's addresses/,
    );
    expect(table.primaryOf(CONTACT)?.email).toBe("old@acme.com");
  });
});

describe("bestPrimaryEmailRow — the ranking (CAR-279)", () => {
  const row = (id: number, over: Partial<{ email: string | null; source: string; bounced_at: string | null }> = {}) => ({
    id,
    email: over.email !== undefined ? over.email : `a${id}@x.com`,
    is_primary: false,
    source: over.source ?? "manual",
    bounced_at: over.bounced_at ?? null,
  });

  it("prefers a row that has an address at all", () => {
    expect(bestPrimaryEmailRow([row(2, { email: null }), row(1)])?.id).toBe(1);
  });

  it("prefers a live address over one that bounced", () => {
    expect(bestPrimaryEmailRow([row(2, { bounced_at: "2026-01-01" }), row(1)])?.id).toBe(1);
  });

  it("prefers stronger provenance", () => {
    expect(
      bestPrimaryEmailRow([row(1, { source: "pattern_guessed" }), row(2, { source: "verified" })])?.id,
    ).toBe(2);
    expect(bestPrimaryEmailRow([row(1, { source: "manual" }), row(2, { source: "scraped" })])?.id).toBe(1);
  });

  it("breaks ties on the most recently added", () => {
    expect(bestPrimaryEmailRow([row(1), row(3), row(2)])?.id).toBe(3);
  });

  it("has nothing to pick from an empty list", () => {
    expect(bestPrimaryEmailRow([])).toBeNull();
  });
});
