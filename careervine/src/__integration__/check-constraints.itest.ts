/**
 * CHECK-constraint conformance (CAR-178, learned rule 40 made mechanical).
 *
 * constants.ts enums are NOT schema truth: a ScheduledEmailStatus value that
 * no migration ever added to the CHECK reached production and failed every
 * MCP cancel with 23514 (CAR-132). This suite closes that gap in both
 * directions, against the real database:
 *
 *  1. Introspection: every app vocabulary must be a SUBSET of the live CHECK's
 *     allowed values for its column (the DB may allow extra legacy values;
 *     the app must never write outside the CHECK).
 *  2. Write path: every value the app can write is actually accepted by
 *     PostgREST on a real row.
 *  3. Enforcement: where we rely on a CHECK existing, a bogus value must be
 *     REJECTED (23514) — so silently dropping the constraint goes red too.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  ActionDirection,
  ActionItemSource,
  AiFollowUpDraftStatus,
  ChangeEventStatus,
  ChangeEventTier,
  ChangeEventType,
  CONVERSATION_TYPE_VALUES,
  EmailDirection,
  INTERACTION_TYPE_VALUES,
  FollowUpMessageStatus,
  FollowUpStatus,
  ScheduledEmailStatus,
  ScrapeMode,
  ScrapeRunStatus,
  ScrapeTrigger,
  SuggestionReasonType,
} from "@/lib/constants";
import {
  createTenant,
  deleteTenant,
  fromTable,
  pgPool,
  serviceClient,
  uniq,
  type Db,
  type Tenant,
} from "./helpers/stack";
import type { TableName } from "./helpers/tenant-graph";

interface VocabSpec {
  name: string;
  table: TableName;
  column: string;
  values: readonly (string | number)[];
  /**
   * True when the app RELIES on this CHECK existing — the enforcement test
   * then proves a bogus write is rejected. False for columns that have no
   * CHECK today (write-path acceptance still proven).
   */
  requireCheck: boolean;
}

const VOCABULARIES: VocabSpec[] = [
  { name: "ScheduledEmailStatus", table: "scheduled_emails", column: "status", values: Object.values(ScheduledEmailStatus), requireCheck: true },
  { name: "FollowUpStatus", table: "email_follow_ups", column: "status", values: Object.values(FollowUpStatus), requireCheck: true },
  { name: "FollowUpMessageStatus", table: "email_follow_up_messages", column: "status", values: Object.values(FollowUpMessageStatus), requireCheck: true },
  { name: "AiFollowUpDraftStatus", table: "ai_follow_up_drafts", column: "status", values: Object.values(AiFollowUpDraftStatus), requireCheck: true },
  { name: "EmailDirection", table: "email_messages", column: "direction", values: Object.values(EmailDirection), requireCheck: true },
  { name: "ActionDirection", table: "follow_up_action_items", column: "direction", values: Object.values(ActionDirection), requireCheck: true },
  { name: "ChangeEventStatus", table: "contact_change_events", column: "status", values: Object.values(ChangeEventStatus), requireCheck: true },
  { name: "ChangeEventTier", table: "contact_change_events", column: "tier", values: Object.values(ChangeEventTier), requireCheck: true },
  { name: "ScrapeRunStatus", table: "scrape_runs", column: "status", values: Object.values(ScrapeRunStatus), requireCheck: true },
  { name: "ScrapeMode", table: "scrape_runs", column: "mode", values: Object.values(ScrapeMode), requireCheck: true },
  { name: "ScrapeTrigger", table: "scrape_runs", column: "trigger", values: Object.values(ScrapeTrigger), requireCheck: true },
  // CAR-242. Both columns were unconstrained varchar until three disjoint
  // vocabularies were collapsed into one; the CHECKs are what keep them that
  // way. INTERACTION_TYPE_VALUES carries the extra system-only 'email'.
  { name: "ConversationType(meetings)", table: "meetings", column: "meeting_type", values: CONVERSATION_TYPE_VALUES, requireCheck: true },
  { name: "InteractionType", table: "interactions", column: "interaction_type", values: INTERACTION_TYPE_VALUES, requireCheck: true },
  // No CHECK on these columns today; write-path acceptance still proven, and
  // the subset assertion arms itself automatically if a CHECK is ever added.
  { name: "ActionItemSource", table: "follow_up_action_items", column: "source", values: Object.values(ActionItemSource), requireCheck: false },
  { name: "ChangeEventType", table: "contact_change_events", column: "type", values: Object.values(ChangeEventType), requireCheck: false },
  { name: "SuggestionReasonType", table: "follow_up_action_items", column: "suggestion_reason_type", values: Object.values(SuggestionReasonType), requireCheck: false },
];

let svc: Db;
let pool: Pool;
let tenant: Tenant;
/** One writable row per table, keyed by table name. */
const rowIds = new Map<string, string | number>();
/** Live allowed values per `${table}.${column}` that carries a CHECK. */
const allowed = new Map<string, Set<string | number>>();

async function loadLiveChecks(): Promise<void> {
  const { rows } = await pool.query<{ table_name: string; def: string }>(
    `SELECT conrelid::regclass::text AS table_name, pg_get_constraintdef(oid) AS def
     FROM pg_constraint
     WHERE connamespace = 'public'::regnamespace AND contype = 'c'`,
  );
  for (const spec of VOCABULARIES) {
    for (const { table_name, def } of rows) {
      if (table_name !== spec.table) continue;
      // pg normalizes `col IN (...)` to `col = ANY (ARRAY[...])`.
      if (!def.includes(`(${spec.column} = ANY `)) continue;
      const arr = /ARRAY\[([^\]]*)\]/.exec(def);
      if (!arr) continue;
      const values = new Set<string | number>(
        arr[1].split(",").map((item) => {
          const s = item.trim();
          const quoted = /^'(.*)'::/.exec(s);
          return quoted ? quoted[1] : Number(s);
        }),
      );
      allowed.set(`${spec.table}.${spec.column}`, values);
    }
  }
}

beforeAll(async () => {
  svc = serviceClient();
  pool = pgPool();
  tenant = await createTenant("check");
  await loadLiveChecks();

  const { data: contact, error: cErr } = await svc
    .from("contacts")
    .insert({ user_id: tenant.userId, name: uniq("check-contact") })
    .select("id")
    .single();
  if (cErr) throw cErr;
  const contactId = contact.id;
  const nowIso = new Date().toISOString();

  const seed = async (table: TableName, payload: Record<string, unknown>) => {
    const { data, error } = await fromTable(svc, table)
      .insert(payload)
      .select("id")
      .single();
    if (error) throw new Error(`seed ${table}: ${error.message}`);
    rowIds.set(table, (data as { id: string | number }).id);
  };

  await seed("scheduled_emails", {
    user_id: tenant.userId,
    recipient_email: "c@example.com",
    subject: "s",
    body_html: "<p>b</p>",
    scheduled_send_at: nowIso,
  });
  await seed("email_follow_ups", {
    user_id: tenant.userId,
    recipient_email: "c@example.com",
    original_sent_at: nowIso,
  });
  await seed("email_follow_up_messages", {
    follow_up_id: rowIds.get("email_follow_ups"),
    sequence_number: 1,
    send_after_days: 3,
    subject: "s",
    body_html: "<p>b</p>",
    scheduled_send_at: nowIso,
  });
  await seed("ai_follow_up_drafts", {
    user_id: tenant.userId,
    contact_id: contactId,
    subject: "s",
    body_html: "<p>b</p>",
    extracted_topic: "t",
    topic_evidence: "e",
  });
  await seed("email_messages", { user_id: tenant.userId, gmail_message_id: uniq("gm") });
  await seed("follow_up_action_items", { user_id: tenant.userId, title: "t" });
  await seed("contact_change_events", {
    user_id: tenant.userId,
    contact_id: contactId,
    type: "promotion",
    dedupe_key: uniq("dk"),
    headline: "h",
  });
  await seed("meetings", { user_id: tenant.userId, meeting_date: nowIso });
  await seed("interactions", {
    contact_id: contactId,
    interaction_date: nowIso,
    interaction_type: "coffee",
  });
  await seed("scrape_runs", {
    user_id: tenant.userId,
    actor: "harvestapi/linkedin-profile-scraper",
    mode: "profile",
    trigger: "manual",
  });
});

afterAll(async () => {
  if (tenant) await deleteTenant(tenant.userId);
  await pool.end();
});

it("every app vocabulary is a subset of its live CHECK constraint", () => {
  const violations: string[] = [];
  for (const spec of VOCABULARIES) {
    const key = `${spec.table}.${spec.column}`;
    const live = allowed.get(key);
    if (!live) {
      if (spec.requireCheck) violations.push(`${spec.name}: expected a CHECK on ${key}, found none`);
      continue;
    }
    for (const v of spec.values) {
      if (!live.has(v)) {
        violations.push(
          `${spec.name}.${String(v)}: app writes it but the CHECK on ${key} only allows [${[...live].join(", ")}]`,
        );
      }
    }
  }
  expect(violations).toEqual([]);
});

it("every value the app writes is accepted on a real row", async () => {
  const failures: string[] = [];
  for (const spec of VOCABULARIES) {
    const id = rowIds.get(spec.table);
    if (id === undefined) throw new Error(`no seeded row for ${spec.table}`);
    for (const v of spec.values) {
      const { error } = await fromTable(svc, spec.table)
        .update({ [spec.column]: v })
        .eq("id", id);
      if (error) failures.push(`${spec.name}.${String(v)} → ${spec.table}.${spec.column}: ${error.code} ${error.message}`);
    }
  }
  expect(failures).toEqual([]);
});

it("a value outside the CHECK is rejected with 23514 (constraint actually enforced)", async () => {
  const failures: string[] = [];
  for (const spec of VOCABULARIES.filter((s) => s.requireCheck)) {
    const id = rowIds.get(spec.table);
    const bogus = typeof spec.values[0] === "number" ? -999 : "itest_bogus_value";
    const { error } = await fromTable(svc, spec.table)
      .update({ [spec.column]: bogus })
      .eq("id", id);
    if (!error) {
      failures.push(`${spec.table}.${spec.column}: bogus value was accepted — CHECK missing or dropped`);
    } else if (error.code !== "23514") {
      failures.push(`${spec.table}.${spec.column}: expected 23514, got ${error.code} ${error.message}`);
    }
  }
  expect(failures).toEqual([]);
});

it("a *_type_detail is rejected unless its type is 'other' (CAR-242)", async () => {
  const cases = [
    { table: "meetings" as const, typeCol: "meeting_type", detailCol: "meeting_type_detail" },
    { table: "interactions" as const, typeCol: "interaction_type", detailCol: "interaction_type_detail" },
  ];
  const failures: string[] = [];
  for (const { table, typeCol, detailCol } of cases) {
    const id = rowIds.get(table);

    // Detail alongside a non-'other' type: rejected.
    const bad = await fromTable(svc, table)
      .update({ [typeCol]: "coffee", [detailCol]: "Alumni panel" })
      .eq("id", id);
    if (!bad.error) failures.push(`${table}: detail accepted on a non-'other' type — CHECK missing or dropped`);
    else if (bad.error.code !== "23514") failures.push(`${table}: expected 23514, got ${bad.error.code} ${bad.error.message}`);

    // The same detail under 'other': accepted.
    const good = await fromTable(svc, table)
      .update({ [typeCol]: "other", [detailCol]: "Alumni panel" })
      .eq("id", id);
    if (good.error) failures.push(`${table}: detail rejected under 'other': ${good.error.code} ${good.error.message}`);

    // Over the 80-char cap: rejected.
    const tooLong = await fromTable(svc, table)
      .update({ [typeCol]: "other", [detailCol]: "x".repeat(81) })
      .eq("id", id);
    if (!tooLong.error) failures.push(`${table}: an 81-char detail was accepted — length half of the CHECK is missing`);
  }
  expect(failures).toEqual([]);
});
