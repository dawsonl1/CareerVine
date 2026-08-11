/**
 * An in-memory `contact_emails` table for the CAR-279 tests.
 *
 * The functions under test are about the STATE a contact's address list ends up
 * in — which row is primary, which survived, what provenance it kept — so the
 * fixture models the rows rather than the call sequence. Asserting on ordered
 * PostgREST calls would pass just as happily for code that wrote the right
 * statements in an order that leaves the contact with two primaries.
 *
 * Deliberately does NOT emulate the migration's triggers or its partial unique
 * index. The data layer has to hold the invariant on its own here; that the
 * database also holds it for every other writer is what
 * `one-primary-email.itest.ts` proves, against real Postgres.
 */
import type { QueryClient } from "@/lib/data/client";

export interface FakeEmailRow {
  id: number;
  contact_id: number;
  email: string | null;
  is_primary: boolean;
  source: string;
  bounced_at: string | null;
}

export interface FakeQuery {
  table: string;
  op: "select" | "insert" | "update" | "delete";
  payload?: unknown;
  filters: Array<{ method: string; args: unknown[] }>;
}

export type FakeResult = { data: unknown; error: unknown };

type SeedRow = Partial<FakeEmailRow> & { email: string | null };

export class FakeEmailTable {
  rows: FakeEmailRow[] = [];
  private nextId = 1;

  /** Seed one contact's addresses. Ids ascend in the order given (= insertion order). */
  seed(contactId: number, rows: SeedRow[]) {
    for (const r of rows) {
      this.rows.push({
        id: r.id ?? this.nextId++,
        contact_id: r.contact_id ?? contactId,
        email: r.email,
        is_primary: r.is_primary ?? false,
        source: r.source ?? "manual",
        bounced_at: r.bounced_at ?? null,
      });
    }
    this.nextId = Math.max(this.nextId, ...this.rows.map((r) => r.id + 1));
    return this;
  }

  of(contactId: number): FakeEmailRow[] {
    return this.rows.filter((r) => r.contact_id === contactId).sort((a, b) => a.id - b.id);
  }

  primaryOf(contactId: number): FakeEmailRow | undefined {
    return this.of(contactId).find((r) => r.is_primary);
  }

  addressesOf(contactId: number): string[] {
    return this.of(contactId).map((r) => r.email ?? "");
  }

  /** Runs a recorded query. Returns undefined for tables this fake does not own. */
  apply(q: FakeQuery): FakeResult | undefined {
    if (q.table !== "contact_emails") return undefined;

    const matches = (row: FakeEmailRow) =>
      q.filters.every((f) => {
        const value = row[f.args[0] as keyof FakeEmailRow];
        if (f.method === "eq") return value === f.args[1];
        if (f.method === "in") return (f.args[1] as unknown[]).includes(value);
        return true; // select/order/limit narrow nothing here
      });

    if (q.op === "select") {
      const limit = q.filters.find((f) => f.method === "limit")?.args[0] as number | undefined;
      const hit = this.rows.filter(matches).sort((a, b) => a.id - b.id);
      return { data: limit != null ? hit.slice(0, limit) : hit, error: null };
    }
    if (q.op === "update") {
      for (const row of this.rows.filter(matches)) Object.assign(row, q.payload as Partial<FakeEmailRow>);
      return { data: null, error: null };
    }
    if (q.op === "delete") {
      const doomed = new Set(this.rows.filter(matches).map((r) => r.id));
      this.rows = this.rows.filter((r) => !doomed.has(r.id));
      return { data: null, error: null };
    }
    const payload = (Array.isArray(q.payload) ? q.payload : [q.payload]) as Array<Partial<FakeEmailRow>>;
    for (const row of payload) {
      this.rows.push({
        id: this.nextId++,
        contact_id: row.contact_id as number,
        email: row.email ?? null,
        is_primary: row.is_primary ?? false,
        source: row.source ?? "manual",
        bounced_at: row.bounced_at ?? null,
      });
    }
    return { data: null, error: null };
  }

  /** A Supabase-shaped client backed by this table; other tables resolve empty. */
  client(): QueryClient {
    return {
      from: (name: string) => {
        const q: FakeQuery = { table: name, op: "select", filters: [] };
        // Arrow function, so `this` is the table without aliasing it.
        const resolve = (): FakeResult => this.apply(q) ?? { data: null, error: null };
        const builder: Record<string, unknown> = {};
        const chain = (method: string) => (...args: unknown[]) => {
          q.filters.push({ method, args });
          return builder;
        };
        Object.assign(builder, {
          select: chain("select"),
          eq: chain("eq"),
          in: chain("in"),
          order: chain("order"),
          limit: chain("limit"),
          insert(payload: unknown) { q.op = "insert"; q.payload = payload; return builder; },
          update(payload: unknown) { q.op = "update"; q.payload = payload; return builder; },
          delete() { q.op = "delete"; return builder; },
          async single() { const r = resolve(); return { ...r, data: (r.data as unknown[])?.[0] ?? null }; },
          async maybeSingle() { const r = resolve(); return { ...r, data: (r.data as unknown[])?.[0] ?? null }; },
          then(onFulfilled: (v: FakeResult) => unknown) { return Promise.resolve(resolve()).then(onFulfilled); },
        });
        return builder;
      },
    } as unknown as QueryClient;
  }
}
