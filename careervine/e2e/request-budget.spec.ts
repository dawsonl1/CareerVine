/**
 * Flow 10 (CAR-229): a per-route ceiling on how many data requests a page load
 * may make.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * Four tickets in this area are already Done (CAR-92, 93, 94, 96) and the pages
 * kept getting slow again, because nothing mechanically stopped an N+1 from
 * being reintroduced. Measured in production on an account with ~2,005
 * contacts, before the CAR-229 round of fixes:
 *
 *     /companies   84 requests
 *     /meetings    40 requests   (a 15 x 2 fan-out over meetings)
 *     /            50 requests
 *     /contacts    13 requests but 14.8s
 *     /settings     6 requests   — the healthy floor
 *
 * Every one of those is a per-row fan-out in the browser, which is exactly what
 * a request count catches and what a unit test cannot: the fan-out is a property
 * of how the page composes its data, not of any single function.
 *
 * ── What this does NOT catch, stated after measuring rather than before ───
 *
 * A WHOLE-TABLE SWEEP IS ESSENTIALLY INVISIBLE HERE, for two different reasons
 * depending on where it runs.
 *
 * Inside an `/api/*` handler, `paginateAll()` over 2,005 contacts is three
 * PostgREST round trips that never touch the browser: one request, however slow.
 *
 * On the pages below it is worse than that, because several of them read the
 * data layer straight from the browser — `/` alone issues 5 GETs against
 * `/rest/v1/contacts`, one per whole-network derivation. Those ARE counted, but
 * a sweep only costs an extra request once the account passes a 1,000-row page,
 * so at this file's seeded scale each sweep bills exactly 1 and the ceiling
 * cannot tell a sweep from a keyed read. `/contacts` measures 7 requests here
 * and measured 14.8s in production at 13.
 *
 * So: this guard owns FAN-OUT (one request per rendered row), and
 * `scripts/check-conventions.mjs`'s exhaustive-sweep check owns SWEEPS. Neither
 * is a superset of the other, and a claim that this file covers "the performance
 * regressions" would be false.
 *
 * ── The seeded tenant ─────────────────────────────────────────────────────
 *
 * This file owns its tenant rather than borrowing the shared one, for the reason
 * `e2e/helpers/tenant.ts` gives: the damage is wider than a restore. It seeds
 * volume the other flows must not carry, and a per-row fan-out is INVISIBLE at
 * the shared tenant's one-row-per-table scale — an N+1 over 1 meeting is 1
 * request. `SEED` below is the smallest collection seeded, and it is deliberately
 * several times the headroom on any ceiling, so a reintroduced fan-out cannot
 * hide inside the slack.
 *
 * ── Setting a ceiling ─────────────────────────────────────────────────────
 *
 * MEASURE, do not guess. Run with `REQUEST_BUDGET_VERBOSE=1` to print each
 * route's tally, then set the ceiling at the measured number plus a small
 * headroom, and say in the comment what the number is protecting against. A
 * ceiling nobody can hit protects nothing; a ceiling that flakes gets deleted.
 * When a legitimate change adds a request, raise the ceiling by that amount in
 * the same PR and say why — the guard is a ratchet on intent, not a freeze.
 */
import { test, expect } from "./fixtures/test";
import {
  createTenant,
  deleteTenant,
  serviceClient,
  completeOnboarding,
  mintSessionUrl,
  seedGmailConnection,
  seedTenantGraph,
  uniq,
  type Tenant,
} from "./helpers/tenant";
import { measurePageLoad, formatTally } from "./helpers/request-budget";
import type { Database } from "@/lib/database.types";

type TableName = keyof Database["public"]["Tables"] & string;
type Insertable<T extends TableName> = Database["public"]["Tables"][T]["Insert"];

// Its own identity, signed out at the project level (same documented exception
// as capability-gating and admin-surface).
test.use({ storageState: { cookies: [], origins: [] } });

/**
 * Rows per collection.
 *
 * 20 is the floor, and the floor is what matters: the largest headroom on any
 * ceiling below is +5, so a fan-out of one request per row costs at least 20 and
 * clears every ceiling by 4x. Raising this makes the guard no sharper and makes
 * every page render slower; lowering it toward the shared tenant's scale is what
 * would make an N+1 invisible again.
 */
const SEED = 20;
/** Contacts get double, so the list pages have rows the row-fan-out would hit. */
const SEED_CONTACTS = SEED * 2;

let tenant: Tenant;
/** Shared-catalog rows this file owns and must remove itself — see afterAll. */
let seededCompanyIds: number[] = [];

test.beforeAll(async () => {
  tenant = await createTenant("e2e-budget");
  const svc = serviceClient();

  // The base graph first: it puts at least one row in every user-owned table, so
  // no page renders an empty state for a reason unrelated to volume.
  await seedTenantGraph(svc, tenant.userId);
  // Premium, so /inbox renders the mailbox shell rather than the Outreach one.
  await seedGmailConnection(tenant.userId);
  await completeOnboarding(tenant.userId);

  const now = Date.now();
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
  const insert = async <T extends TableName>(table: T, payload: Insertable<T>[]) => {
    const { error } = await svc.from(table).insert(payload as never);
    if (error) throw new Error(`seed ${table}: ${error.message}`);
  };
  // `.select("id")` on a generic table resolves to a union across all 60-odd
  // tables, several of which have no `id`, so the row type has to be asserted
  // through `unknown`. Every caller below inserts into a table that does have
  // one, and a wrong one fails loudly on the next line.
  const idsOf = async <T extends TableName>(table: T, payload: Insertable<T>[]): Promise<number[]> => {
    const { data, error } = await svc
      .from(table)
      .insert(payload as never)
      .select("id");
    if (error || !data) throw new Error(`seed ${table}: ${error?.message ?? "no rows"}`);
    return (data as unknown as { id: number }[]).map((r) => r.id);
  };

  // ── Contacts ────────────────────────────────────────────────────────────
  const contactIds = await idsOf(
    "contacts",
    Array.from({ length: SEED_CONTACTS }, (_, i) => ({
      user_id: tenant.userId,
      name: `Budget Contact ${String(i).padStart(3, "0")}`,
      network_status: "active",
      headline: "Product Manager",
    })),
  );
  await insert(
    "contact_emails",
    contactIds.map((id, i) => ({
      contact_id: id,
      email: `${uniq(`budget-${i}`)}@example.com`,
      is_primary: true,
    })),
  );

  // ── Companies, employment edges, and targets ────────────────────────────
  // Every company gets a contact AND a target row: /companies composes both, so
  // seeding only one side would leave half the page's per-row work unmeasured.
  const companyIds = await idsOf(
    "companies",
    Array.from({ length: SEED }, (_, i) => ({ name: uniq(`Budget Co ${i}`) })),
  );
  seededCompanyIds = companyIds;
  await insert(
    "contact_companies",
    companyIds.map((companyId, i) => ({
      contact_id: contactIds[i],
      company_id: companyId,
      is_current: true,
      title: "Product Manager",
    })),
  );
  await insert(
    "target_companies",
    companyIds.map((companyId) => ({
      user_id: tenant.userId,
      company_id: companyId,
      is_targeted: true,
    })),
  );

  // ── Meetings (the 15 x 2 fan-out the baseline measured) ─────────────────
  const meetingIds = await idsOf(
    "meetings",
    Array.from({ length: SEED }, (_, i) => ({
      user_id: tenant.userId,
      title: `Budget Meeting ${i}`,
      meeting_date: iso(-(i + 1) * 86_400_000),
    })),
  );
  await insert(
    "meeting_contacts",
    meetingIds.flatMap((meetingId, i) => [
      { meeting_id: meetingId, contact_id: contactIds[i] },
      { meeting_id: meetingId, contact_id: contactIds[i + SEED] },
    ]),
  );

  // ── Action items ────────────────────────────────────────────────────────
  await insert(
    "follow_up_action_items",
    Array.from({ length: SEED }, (_, i) => ({
      user_id: tenant.userId,
      title: `Budget Action ${i}`,
      contact_id: contactIds[i],
      due_at: iso((i + 1) * 86_400_000),
    })),
  );

  // ── Calendar ────────────────────────────────────────────────────────────
  const eventIds = await idsOf(
    "calendar_events",
    Array.from({ length: SEED }, (_, i) => ({
      user_id: tenant.userId,
      google_event_id: uniq(`budget-ev-${i}`),
      title: `Budget Event ${i}`,
      start_at: iso((i + 1) * 3_600_000),
      end_at: iso((i + 1) * 3_600_000 + 1_800_000),
    })),
  );
  await insert(
    "calendar_event_contacts",
    eventIds.map((eventId, i) => ({ calendar_event_id: eventId, contact_id: contactIds[i] })),
  );

  // ── Inbox ───────────────────────────────────────────────────────────────
  // One message per thread, so `buildThreads` yields SEED threads — a per-thread
  // fetch is the fan-out shape this page is exposed to.
  await insert(
    "email_messages",
    Array.from({ length: SEED }, (_, i) => {
      const gid = uniq(`budget-msg-${i}`);
      return {
        user_id: tenant.userId,
        gmail_message_id: gid,
        thread_id: gid,
        subject: `Budget Subject ${i}`,
        from_address: `budget-sender-${i}@example.com`,
        to_addresses: ["e2e-sender@gmail.com"],
        snippet: `Budget snippet ${i}`,
        direction: "inbound",
        is_read: false,
        is_trashed: false,
        is_hidden: false,
        date: iso(-(i + 1) * 3_600_000),
        label_ids: ["INBOX"],
      };
    }),
  );
});

test.afterAll(async () => {
  // The teardown project also sweeps `itest-e2e-*`, so a crash before here still
  // converges; this just keeps the stack clean within the run.
  if (tenant?.userId) await deleteTenant(tenant.userId);

  // `companies` is the SHARED catalog: deleting the tenant cascades the
  // user-owned rows that point at these (contact_companies, target_companies)
  // but never the companies themselves. Nothing else sweeps them either, so at
  // 20 a run they would accumulate in every developer's local stack forever and
  // eventually surface as an unexplained extra row in someone else's spec.
  // Ordered after deleteTenant so the FK dependents are already gone.
  if (seededCompanyIds.length > 0) {
    await serviceClient().from("companies").delete().in("id", seededCompanyIds);
  }
});

test.beforeEach(async ({ page }) => {
  await page.goto(await mintSessionUrl(tenant.email));
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});

/**
 * Every ceiling is a MEASURED number plus headroom, and every comment says what
 * the number is protecting against. `measured` is recorded beside it so a future
 * change can see how much of the ceiling was slack and how much was real.
 */
interface Budget {
  path: string;
  /** Requests observed at the seeded scale when this ceiling was set. */
  measured: number;
  ceiling: number;
  /** What blowing this ceiling would mean. */
  protects: string;
}

const BUDGETS: Budget[] = [
  {
    path: "/settings",
    measured: 5,
    ceiling: 8,
    // The healthy floor, and the control for every other row: capabilities, the
    // Gmail connection, the unread badge, the user row. If THIS one grows,
    // something was added to the app shell and every other ceiling moved with it.
    protects: "the shared app-shell floor — settings reads no per-row data at all",
  },
  {
    path: "/",
    measured: 34,
    ceiling: 39,
    // The busiest page by far. Its cost is a fixed set of whole-network
    // derivations (core data, due follow-ups, health, on-track, activity) plus
    // ten HEAD count probes; nothing in it scales with a rendered row today.
    // Measured at 43 earlier in CAR-229 and at 34 once the streak and heatmap
    // stopped scanning the same tables twice, which is the kind of gain this
    // number exists to hold on to.
    protects: "another network-wide derivation, or a per-contact/per-item fan-out",
  },
  {
    path: "/contacts",
    measured: 7,
    ceiling: 10,
    // Two reads over the tier being viewed plus the tier counts. A per-row
    // email, company or last-touch fetch behind the list rows is the regression
    // this catches; the 14.8s the baseline measured is NOT visible here (see the
    // header) and belongs to the conventions guard.
    protects: "a per-contact email/company/last-touch fetch behind the list rows",
  },
  {
    path: "/companies",
    measured: 18,
    ceiling: 22,
    // The 84-request baseline was a per-company contacts fetch. The page now
    // composes one batched read per relationship table; 18 is that fixed set,
    // and it does not move with the number of companies.
    protects: "the 84-request baseline: a per-company contacts or intel fetch",
  },
  {
    path: "/meetings",
    measured: 8,
    ceiling: 11,
    // The 15x2 baseline was per-meeting attendees + attachments. Both are single
    // batched reads now, so this ceiling is what stops them being unbatched.
    protects: "the 15x2 baseline: per-meeting attendee and attachment fetches",
  },
  {
    path: "/action-items",
    measured: 9,
    ceiling: 12,
    protects: "a per-item contact or meeting fetch behind the list rows",
  },
  {
    path: "/calendar",
    measured: 7,
    ceiling: 10,
    // The events read is one call for the whole window; the sync POST is the
    // background refresh. A per-event attendee fetch would add one per event.
    protects: "a per-event attendee fetch behind the calendar grid",
  },
  {
    path: "/inbox",
    measured: 7,
    ceiling: 10,
    // Threads arrive already grouped from /api/gmail/inbox. A per-thread body or
    // contact fetch on render is the regression; the click path fetches one body
    // on demand, which is correct and is not part of a load.
    protects: "a per-thread message or contact fetch behind the thread list",
  },
];

for (const { path, measured, ceiling, protects } of BUDGETS) {
  test(`${path} stays within its request budget`, async ({ page }) => {
    const tally = await measurePageLoad(page, path);

    if (process.env.REQUEST_BUDGET_VERBOSE) {
      console.log(
        `\n[request-budget] ${path}: ${tally.total} counted request(s)\n${formatTally(tally.byEndpoint)}\n`,
      );
    }

    expect(
      tally.total,
      `${path} made ${tally.total} data request(s), ceiling ${ceiling} ` +
        `(measured ${measured} when set).\n  Protects against: ${protects}.\n` +
        `  Requests, worst first:\n${formatTally(tally.byEndpoint)}\n` +
        `  If this growth is deliberate, raise the ceiling in e2e/request-budget.spec.ts ` +
        `and say why. If a single endpoint appears once per rendered row, that is an N+1: ` +
        `batch it into one call instead.`,
    ).toBeLessThanOrEqual(ceiling);
  });
}
