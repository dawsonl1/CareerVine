/**
 * "Exactly one primary email per contact" is a DATABASE invariant (CAR-279).
 *
 * The reason it lives in Postgres rather than in the data layer is that six
 * call sites write `contact_emails` directly — the extension import route, bulk
 * import, bundle fast-apply, the Apify merge, admin, MCP — and only two of them
 * shared any promotion logic. The unit tests prove `src/lib/data/contacts.ts`
 * keeps the invariant; only this file proves it holds for a writer that never
 * heard of that module.
 *
 * Integration tier because none of it is reachable in a mock: the partial unique
 * index, the BEFORE trigger that demotes, the AFTER trigger that promotes a
 * survivor and syncs `contacts.preferred_contact_value`, and the ordering
 * guarantee that an after-row trigger on a multi-row DELETE sees the finished
 * statement rather than a half-emptied table.
 *
 * Writes go through the SERVICE client on purpose: it is the least-mediated
 * path to the table, so anything that still holds here holds for every app
 * writer above it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTenant, deleteTenant, serviceClient, pgPool, uniq, type Db, type Tenant } from "./helpers/stack";
import { bestPrimaryEmailRow } from "@/lib/data/contacts";
import type { Pool } from "pg";

let tenant: Tenant;
let svc: Db;
let pool: Pool;

beforeAll(async () => {
  tenant = await createTenant("one-primary-email");
  svc = serviceClient();
  pool = pgPool();
});

afterAll(async () => {
  await pool.end();
  await deleteTenant(tenant.userId);
});

interface SeedRow {
  email: string | null;
  is_primary?: boolean;
  source?: string;
  bounced_at?: string | null;
}

async function makeContact(rows: SeedRow[] = []): Promise<number> {
  const { data, error } = await svc
    .from("contacts")
    .insert({ user_id: tenant.userId, name: uniq("Ada") })
    .select("id")
    .single();
  if (error) throw new Error(`seed contact: ${error.message}`);
  const contactId = data!.id;
  for (const row of rows) {
    // One INSERT per row: seeding a contact's addresses one at a time is what
    // every app writer does, and it lets each row's triggers settle in turn.
    const { error: insErr } = await svc.from("contact_emails").insert({
      contact_id: contactId,
      email: row.email,
      is_primary: row.is_primary ?? false,
      source: row.source ?? "manual",
      bounced_at: row.bounced_at ?? null,
    });
    if (insErr) throw new Error(`seed email ${row.email}: ${insErr.message}`);
  }
  return contactId;
}

async function emailsOf(contactId: number) {
  const { data, error } = await svc
    .from("contact_emails")
    .select("id, email, is_primary, source, bounced_at")
    .eq("contact_id", contactId)
    .order("id");
  if (error) throw new Error(`read emails: ${error.message}`);
  return data ?? [];
}

const primaryOf = async (contactId: number) => (await emailsOf(contactId)).find((r) => r.is_primary);

describe("at most one primary", () => {
  it("rejects a second primary at the index, not merely by convention", async () => {
    const contactId = await makeContact([{ email: "a@x.com", is_primary: true }]);
    // The demote trigger is what normally prevents this, so it is disabled for
    // the length of one statement — otherwise the index can never be observed
    // doing anything and this test would pass against a database with no index
    // at all.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE contact_emails DISABLE TRIGGER contact_emails_demote_other_primaries");
      await expect(
        client.query(
          "INSERT INTO contact_emails (contact_id, email, is_primary) VALUES ($1, 'b@x.com', true)",
          [contactId],
        ),
      ).rejects.toThrow(/contact_emails_one_primary_idx|duplicate key/i);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("demotes the incumbent when a new address arrives as primary", async () => {
    const contactId = await makeContact([{ email: "old@x.com", is_primary: true }]);

    await svc.from("contact_emails").insert({ contact_id: contactId, email: "new@x.com", is_primary: true });

    const rows = await emailsOf(contactId);
    expect(rows.filter((r) => r.is_primary).map((r) => r.email)).toEqual(["new@x.com"]);
    expect(rows).toHaveLength(2);
  });

  it("demotes the incumbent when an existing address is promoted", async () => {
    const contactId = await makeContact([
      { email: "first@x.com", is_primary: true },
      { email: "second@x.com" },
    ]);
    const second = (await emailsOf(contactId)).find((r) => r.email === "second@x.com")!;

    await svc.from("contact_emails").update({ is_primary: true }).eq("id", second.id);

    expect((await primaryOf(contactId))?.email).toBe("second@x.com");
  });

  it("lets a bulk insert covering many contacts through", async () => {
    // bulk-import and bundle fast-apply insert one primary per NEW contact in a
    // single statement. If the demote trigger's nested UPDATE could touch a row
    // from its own statement, this is where it would break.
    const ids = [await makeContact(), await makeContact(), await makeContact()];

    const { error } = await svc.from("contact_emails").insert(
      ids.map((id, i) => ({ contact_id: id, email: `bulk${i}@x.com`, is_primary: true })),
    );

    expect(error).toBeNull();
    for (const id of ids) expect((await primaryOf(id))?.is_primary).toBe(true);
  });
});

describe("at least one primary", () => {
  it("promotes a survivor when the primary is deleted", async () => {
    const contactId = await makeContact([
      { email: "gone@x.com", is_primary: true },
      { email: "kept@x.com" },
    ]);
    const doomed = (await emailsOf(contactId)).find((r) => r.email === "gone@x.com")!;

    await svc.from("contact_emails").delete().eq("id", doomed.id);

    expect((await primaryOf(contactId))?.email).toBe("kept@x.com");
  });

  it("promotes a survivor when the primary is merely demoted", async () => {
    const contactId = await makeContact([
      { email: "a@x.com", is_primary: true },
      { email: "b@x.com" },
    ]);
    const a = (await emailsOf(contactId)).find((r) => r.email === "a@x.com")!;

    await svc.from("contact_emails").update({ is_primary: false }).eq("id", a.id);

    expect((await primaryOf(contactId))?.email).toBe("b@x.com");
  });

  it("promotes a first address that arrives as non-primary", async () => {
    // The Gmail path files a newly discovered reply address this way.
    const contactId = await makeContact();

    await svc.from("contact_emails").insert({
      contact_id: contactId, email: "discovered@x.com", is_primary: false, source: "verified",
    });

    expect((await primaryOf(contactId))?.email).toBe("discovered@x.com");
  });

  it("promotes nothing when every address is deleted at once", async () => {
    // After-row triggers fire once the whole DELETE has landed, so this must not
    // resurrect a primary on a row that is already gone.
    const contactId = await makeContact([
      { email: "a@x.com", is_primary: true },
      { email: "b@x.com" },
      { email: "c@x.com" },
    ]);

    await svc.from("contact_emails").delete().eq("contact_id", contactId);

    expect(await emailsOf(contactId)).toEqual([]);
  });

  it("ranks the survivor: live address, then provenance, then newest", async () => {
    const contactId = await makeContact([
      { email: "primary@x.com", is_primary: true },
      { email: "dead@x.com", source: "verified", bounced_at: "2026-06-01T00:00:00Z" },
      { email: "guessed@x.com", source: "pattern_guessed" },
      { email: "scraped@x.com", source: "scraped" },
    ]);
    const doomed = (await emailsOf(contactId)).find((r) => r.email === "primary@x.com")!;

    await svc.from("contact_emails").delete().eq("id", doomed.id);

    expect((await primaryOf(contactId))?.email).toBe("scraped@x.com");
  });
});

describe("SQL and TypeScript rank survivors identically", () => {
  // Two implementations of one rule: best_primary_contact_email() in the
  // migration, bestPrimaryEmailRow() in src/lib/data/contacts.ts. The UI ranks
  // optimistically with the TS one and the database settles it with the SQL
  // one, so a drift shows up as a primary that moves after a reload.
  const FIXTURES: Array<{ name: string; rows: SeedRow[] }> = [
    { name: "live beats bounced", rows: [
      { email: "dead@x.com", bounced_at: "2026-01-01T00:00:00Z" },
      { email: "live@x.com" },
    ] },
    { name: "provenance beats recency", rows: [
      { email: "verified@x.com", source: "verified" },
      { email: "guessed@x.com", source: "pattern_guessed" },
    ] },
    { name: "recency breaks a tie", rows: [
      { email: "older@x.com", source: "manual" },
      { email: "newer@x.com", source: "manual" },
    ] },
    { name: "an address beats a blank row", rows: [
      { email: null },
      { email: "real@x.com" },
    ] },
    { name: "all bounced still yields one", rows: [
      { email: "dead1@x.com", source: "scraped", bounced_at: "2026-01-01T00:00:00Z" },
      { email: "dead2@x.com", source: "verified", bounced_at: "2026-01-01T00:00:00Z" },
    ] },
  ];

  for (const fixture of FIXTURES) {
    it(fixture.name, async () => {
      const contactId = await makeContact(fixture.rows);
      const rows = await emailsOf(contactId);

      const { rows: sql } = await pool.query<{ best: number | null }>(
        "SELECT best_primary_contact_email($1) AS best",
        [contactId],
      );

      expect(sql[0].best).toBe(bestPrimaryEmailRow(rows)?.id ?? null);
    });
  }
});

describe("the trigger stays inside contact_emails", () => {
  // It used to keep `contacts.preferred_contact_value` in step, which cost every
  // auth-user deletion a `permission denied for table contacts` — GoTrue's
  // cascade reaches these rows and its role cannot touch `contacts`. That is why
  // deleting a tenant (this file's own afterAll) is a real assertion.
  it("does not write contacts when the primary moves", async () => {
    const contactId = await makeContact([{ email: "old@x.com", is_primary: true }]);
    await svc
      .from("contacts")
      .update({ preferred_contact_method: "email", preferred_contact_value: "old@x.com" })
      .eq("id", contactId);

    await svc.from("contact_emails").insert({ contact_id: contactId, email: "new@x.com", is_primary: true });

    const { data } = await svc.from("contacts").select("preferred_contact_value").eq("id", contactId).single();
    expect(data?.preferred_contact_value).toBe("old@x.com");
  });

  it("survives a cascading delete of the whole contact", async () => {
    const contactId = await makeContact([
      { email: "a@x.com", is_primary: true },
      { email: "b@x.com" },
    ]);

    const { error } = await svc.from("contacts").delete().eq("id", contactId);

    expect(error).toBeNull();
    expect(await emailsOf(contactId)).toEqual([]);
  });
});

describe("under the browser's own client, with RLS on", () => {
  // Everything above writes as service_role. The web app writes as
  // `authenticated` through a policy that is an EXISTS over `contacts`, which is
  // a different evaluation path entirely — and the one the edit modal uses.
  it("promotes a survivor when the tenant deletes their primary", async () => {
    const contactId = await makeContact([
      { email: "gone@x.com", is_primary: true },
      { email: "kept@x.com" },
    ]);
    const doomed = (await emailsOf(contactId)).find((r) => r.email === "gone@x.com")!;

    const { error } = await tenant.client.from("contact_emails").delete().eq("id", doomed.id);

    expect(error).toBeNull();
    expect((await primaryOf(contactId))?.email).toBe("kept@x.com");
  });

  it("demotes the incumbent when the tenant promotes another address", async () => {
    const contactId = await makeContact([
      { email: "first@x.com", is_primary: true },
      { email: "second@x.com" },
    ]);
    const second = (await emailsOf(contactId)).find((r) => r.email === "second@x.com")!;

    const { error } = await tenant.client
      .from("contact_emails")
      .update({ is_primary: true })
      .eq("id", second.id);

    expect(error).toBeNull();
    const rows = await emailsOf(contactId);
    expect(rows.filter((r) => r.is_primary).map((r) => r.email)).toEqual(["second@x.com"]);
  });
});

describe("the backfill", () => {
  // Re-runs the migration's own two repair statements against deliberately
  // broken rows. Both states existed in production before this shipped, and the
  // partial unique index cannot be created while the first one does.
  const BACKFILL_TWO_PRIMARIES = `
    WITH ranked AS (
      SELECT id, row_number() OVER (
               PARTITION BY contact_id
               ORDER BY (email IS NOT NULL) DESC, (bounced_at IS NULL) DESC,
                        CASE source WHEN 'verified' THEN 4 WHEN 'manual' THEN 3
                                    WHEN 'scraped' THEN 2 WHEN 'pattern_guessed' THEN 1
                                    ELSE 0 END DESC,
                        id DESC) AS rn
        FROM contact_emails WHERE is_primary AND contact_id = $1
    )
    UPDATE contact_emails ce SET is_primary = false FROM ranked r
     WHERE ce.id = r.id AND r.rn > 1`;

  const BACKFILL_NO_PRIMARY = `
    UPDATE contact_emails SET is_primary = true
     WHERE id = best_primary_contact_email($1)
       AND NOT EXISTS (SELECT 1 FROM contact_emails WHERE contact_id = $1 AND is_primary)`;

  it("leaves one primary behind when a contact had two", async () => {
    const contactId = await makeContact([{ email: "a@x.com", is_primary: true }]);
    const client = await pool.connect();
    try {
      await client.query("ALTER TABLE contact_emails DISABLE TRIGGER contact_emails_demote_other_primaries");
      await client.query("ALTER INDEX contact_emails_one_primary_idx RENAME TO contact_emails_one_primary_idx_off");
      await client.query("DROP INDEX contact_emails_one_primary_idx_off");
      await client.query(
        "INSERT INTO contact_emails (contact_id, email, is_primary, source) VALUES ($1, 'b@x.com', true, 'verified')",
        [contactId],
      );

      await client.query(BACKFILL_TWO_PRIMARIES, [contactId]);

      const { rows } = await client.query<{ email: string }>(
        "SELECT email FROM contact_emails WHERE contact_id = $1 AND is_primary",
        [contactId],
      );
      expect(rows.map((r) => r.email)).toEqual(["b@x.com"]);
    } finally {
      await client.query(
        "CREATE UNIQUE INDEX IF NOT EXISTS contact_emails_one_primary_idx ON contact_emails (contact_id) WHERE is_primary",
      );
      await client.query("ALTER TABLE contact_emails ENABLE TRIGGER contact_emails_demote_other_primaries");
      client.release();
    }
  });

  it("gives a contact with addresses and no primary one", async () => {
    const contactId = await makeContact([{ email: "a@x.com", is_primary: true }]);
    const client = await pool.connect();
    try {
      await client.query("ALTER TABLE contact_emails DISABLE TRIGGER contact_emails_ensure_primary");
      await client.query("UPDATE contact_emails SET is_primary = false WHERE contact_id = $1", [contactId]);

      await client.query(BACKFILL_NO_PRIMARY, [contactId]);

      const { rows } = await client.query<{ email: string }>(
        "SELECT email FROM contact_emails WHERE contact_id = $1 AND is_primary",
        [contactId],
      );
      expect(rows.map((r) => r.email)).toEqual(["a@x.com"]);
    } finally {
      await client.query("ALTER TABLE contact_emails ENABLE TRIGGER contact_emails_ensure_primary");
      client.release();
    }
  });
});
