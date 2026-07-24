/**
 * CAR-175: destructive migrations must not erase application-owned columns.
 *
 * `calendar_events` is a cache of Google Calendar, but not ALL of it comes from
 * Google. Four columns are written only by this application and can never be
 * restored by a re-sync, because Google has no record of them:
 *
 *   - source_gmail_thread_id / source_gmail_message_id — written only by
 *     POST /api/calendar/create-event when a user books a meeting from an
 *     Inbox thread. They power the linked-meeting chip
 *     (GET /api/gmail/inbox builds calendarByThread from them).
 *   - meeting_id — app-side link to a CareerVine meetings row.
 *   - zoom_link — app-side; the sync route never writes it.
 *
 * Ordinary syncs preserve these by construction: the sync route's upsert
 * payload omits them, and PostgREST's ON CONFLICT DO UPDATE only touches keys
 * present in the payload. The failure mode is DELETE-and-resync: the CAR-152
 * repair migration (20260717040000_car152_calendar_sync_repair.sql) deleted
 * every row in the -7d/+60d sync window and forced a windowed re-fetch, which
 * re-INSERTed each event with the source columns NULL. Every email-to-meeting
 * link in the window was silently and irreversibly destroyed — the deleted
 * rows were the only place the association existed (the meetings table has no
 * thread column, and the plan has no PITR). That migration is grandfathered
 * below; this test exists so it stays the only member of that club.
 *
 * The rule it enforces: any migration statement that deletes or truncates rows
 * from a registered table must either
 *   (a) reference every registered app-owned column inside the statement — an
 *       `AND source_gmail_thread_id IS NULL`-style guard, or a save/restore
 *       CTE keyed by (user_id, google_event_id) — or
 *   (b) carry a `-- destructive-resync-audited: CAR-XX <reason>` annotation on
 *       one of the few lines directly above it, forcing a conscious,
 *       ticket-linked decision instead of a silent repeat.
 *
 * Following check-conventions.test.ts: a guard that cannot be shown to trip is
 * indistinguishable from one that does nothing, so the scanner is exercised
 * against fixtures it MUST reject alongside the real migrations directory.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TablesInsert } from "../lib/database.types";

// Resolved from this file, not process.cwd(), so the test is
// invocation-independent (CI runs vitest from careervine/).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");
const SYNC_ROUTE = path.join(HERE, "..", "app", "api", "calendar", "sync", "route.ts");

/**
 * App-owned columns per Google-synced cache table. `satisfies` ties each name
 * to the generated schema types, so a rename or drop turns this registry into
 * a compile error (CI runs tsc --noEmit) instead of letting it rot.
 */
const CALENDAR_EVENTS_APP_OWNED = [
  "source_gmail_thread_id",
  "source_gmail_message_id",
  "meeting_id",
  "zoom_link",
] as const satisfies ReadonlyArray<keyof TablesInsert<"calendar_events">>;

const APP_OWNED_COLUMNS: Record<string, readonly string[]> = {
  calendar_events: CALENDAR_EVENTS_APP_OWNED,
};

/**
 * Applied before this guard existed; its damage is done and the file is inert
 * (applied migrations never re-run). Recorded here rather than edited in
 * place. Nothing else may join this list — annotate new migrations instead.
 */
const GRANDFATHERED = new Set(["20260717040000_car152_calendar_sync_repair.sql"]);

const ANNOTATION = /--\s*destructive-resync-audited:\s*CAR-\d+\s+\S/;
/** How many raw lines above the statement may carry the annotation. */
const ANNOTATION_LOOKBACK = 4;

type Violation = { file: string; line: number; table: string; missing: string[] };

/**
 * Blank out SQL comments while preserving offsets/line structure, so comment
 * text can neither hide a destructive statement nor satisfy the column check.
 * (The audit annotation is read from the RAW text separately.)
 */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/--[^\n]*/g, (m) => " ".repeat(m.length));
}

/** Scan one migration's SQL for unguarded destructive statements. */
export function scanMigrationSql(file: string, rawSql: string): Violation[] {
  const stripped = stripSqlComments(rawSql);
  const rawLines = rawSql.split("\n");
  const violations: Violation[] = [];

  const destructive = /\b(?:DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?(?:\s+ONLY)?)\s+(?:"?public"?\.)?"?([a-zA-Z_]\w*)"?/gi;
  for (const match of stripped.matchAll(destructive)) {
    const table = match[1].toLowerCase();
    const owned = APP_OWNED_COLUMNS[table];
    if (!owned) continue;

    const start = match.index ?? 0;
    const end = stripped.indexOf(";", start);
    const statement = stripped.slice(start, end === -1 ? undefined : end);
    const missing = owned.filter((col) => !new RegExp(`\\b${col}\\b`, "i").test(statement));
    if (missing.length === 0) continue;

    const line = stripped.slice(0, start).split("\n").length; // 1-indexed
    const lookback = rawLines.slice(Math.max(0, line - 1 - ANNOTATION_LOOKBACK), line - 1);
    if (lookback.some((l) => ANNOTATION.test(l))) continue;

    violations.push({ file, line, table, missing });
  }
  return violations;
}

describe("registry stays true to the codebase", () => {
  it("sync route's upsert payload writes none of the app-owned columns", () => {
    // If sync ever starts writing one of these, ordinary upserts would clobber
    // app data and the column is no longer app-owned — the registry and this
    // test must be revisited, not just the code.
    const src = readFileSync(SYNC_ROUTE, "utf8");
    for (const col of CALENDAR_EVENTS_APP_OWNED) {
      expect(src, `${col} must not appear as a payload key in sync/route.ts`).not.toMatch(
        new RegExp(`\\b${col}\\s*:`),
      );
    }
  });

  it("payload-key scan itself trips on a written column (control)", () => {
    expect(/\bmeeting_id\s*:/.test("  meeting_id: null,")).toBe(true);
  });
});

describe("scanner trips where it must (fixtures)", () => {
  const bareDelete =
    "DELETE FROM calendar_events\nWHERE start_at >= now() - interval '7 days';\n";

  it("rejects a bare windowed delete (the CAR-152 shape)", () => {
    const v = scanMigrationSql("fixture.sql", bareDelete);
    expect(v).toHaveLength(1);
    expect(v[0].missing).toEqual([...CALENDAR_EVENTS_APP_OWNED]);
  });

  it("rejects TRUNCATE, with and without TABLE/ONLY/public qualifiers", () => {
    for (const stmt of [
      "TRUNCATE calendar_events;",
      "TRUNCATE TABLE calendar_events;",
      'TRUNCATE TABLE ONLY "public"."calendar_events";',
      "DELETE FROM public.calendar_events;",
    ]) {
      expect(scanMigrationSql("fixture.sql", stmt), stmt).toHaveLength(1);
    }
  });

  it("rejects a PARTIAL guard — preserving thread ids alone still destroys the rest", () => {
    const v = scanMigrationSql(
      "fixture.sql",
      "DELETE FROM calendar_events WHERE start_at >= now() AND source_gmail_thread_id IS NULL;",
    );
    expect(v).toHaveLength(1);
    expect(v[0].missing).toEqual(["source_gmail_message_id", "meeting_id", "zoom_link"]);
  });

  it("does not let a comment satisfy the column check or hide a statement", () => {
    const commentGuard =
      "-- preserves source_gmail_thread_id source_gmail_message_id meeting_id zoom_link\n" +
      "DELETE FROM calendar_events;\n";
    expect(scanMigrationSql("fixture.sql", commentGuard)).toHaveLength(1);

    const commentOnly = "-- never DELETE FROM calendar_events without a guard\n";
    expect(scanMigrationSql("fixture.sql", commentOnly)).toHaveLength(0);
  });

  it("accepts a delete guarded on every app-owned column", () => {
    const guarded =
      "DELETE FROM calendar_events\n" +
      "WHERE start_at >= now() - interval '7 days'\n" +
      "  AND source_gmail_thread_id IS NULL\n" +
      "  AND source_gmail_message_id IS NULL\n" +
      "  AND meeting_id IS NULL\n" +
      "  AND zoom_link IS NULL;\n";
    expect(scanMigrationSql("fixture.sql", guarded)).toHaveLength(0);
  });

  it("accepts an audited annotation directly above, and only directly above", () => {
    const annotated =
      "-- destructive-resync-audited: CAR-999 save/restore CTE runs in the next statement\n" +
      "DELETE FROM calendar_events;\n";
    expect(scanMigrationSql("fixture.sql", annotated)).toHaveLength(0);

    const tooFar =
      "-- destructive-resync-audited: CAR-999 reason\n" +
      "\n\n\n\n\n" +
      "DELETE FROM calendar_events;\n";
    expect(scanMigrationSql("fixture.sql", tooFar)).toHaveLength(1);

    // A bare annotation with no ticket or reason does not count.
    const lazy = "-- destructive-resync-audited:\nDELETE FROM calendar_events;\n";
    expect(scanMigrationSql("fixture.sql", lazy)).toHaveLength(1);
  });

  it("ignores tables outside the registry", () => {
    expect(scanMigrationSql("fixture.sql", "DELETE FROM email_messages;")).toHaveLength(0);
  });
});

describe("real migrations directory", () => {
  it("contains no unguarded destructive statement against a registered table", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
    expect(files.length).toBeGreaterThan(50); // wrong-dir tripwire

    const violations = files
      .filter((f) => !GRANDFATHERED.has(f))
      .flatMap((f) => scanMigrationSql(f, readFileSync(path.join(MIGRATIONS_DIR, f), "utf8")));

    expect(
      violations,
      violations
        .map(
          (v) =>
            `${v.file}:${v.line} — destructive statement on ${v.table} does not preserve ` +
            `app-owned column(s) ${v.missing.join(", ")}. Guard the delete (e.g. AND ` +
            `${v.missing[0]} IS NULL), save/restore them keyed by (user_id, google_event_id), ` +
            `or add "-- destructive-resync-audited: CAR-XX <reason>" directly above. See CAR-175.`,
        )
        .join("\n"),
    ).toHaveLength(0);
  });

  it("the grandfathered CAR-152 migration is still the shape this guard exists for", () => {
    // If this file is ever rewritten to be guarded (or removed), drop it from
    // GRANDFATHERED so the allowlist cannot silently shelter a future edit.
    const name = "20260717040000_car152_calendar_sync_repair.sql";
    const sql = readFileSync(path.join(MIGRATIONS_DIR, name), "utf8");
    expect(scanMigrationSql(name, sql).length).toBeGreaterThan(0);
  });
});
