/**
 * The /outreach query waterfall, pinned by SHAPE rather than by wall clock
 * (CAR-229).
 *
 * ── What "shape" means here ───────────────────────────────────────────────
 *
 * Two numbers, and the second is the one that matters:
 *
 *  - REQUEST COUNT — how much work the page asks the database for.
 *  - SERIAL DEPTH — the longest chain of requests that must complete one after
 *    another. Latency is depth x round trip; count only matters once depth is
 *    flat. A page issuing 40 requests in 2 waves is fast; one issuing 20 in 20
 *    waves is the 5.4s waterfall this ticket measured in production.
 *
 * Depth is measured by RUNNING the real functions against a gated client: every
 * query parks instead of resolving, the harness releases all parked queries at
 * once, and each release is one wave. A query that only starts because an
 * earlier one finished therefore lands in a later wave by construction. Nothing
 * here asserts on source order, so reordering awaits cannot fake a pass and
 * only removing a real dependency can move a number.
 *
 * ── The regression this exists to catch ───────────────────────────────────
 *
 * Every `await` in these two functions that is ordering rather than dependency
 * costs a full round trip on a page that runs both. getCompanyDetail carried
 * four of them (the viewer's school gating everything, the roster gating the
 * per-contact legs, those legs gating the stage fan-out, the stage fan-out
 * gating a single-row notes read) and measured six waves deep for work that
 * only ever needed two. Re-introducing any one of them fails the wave-membership
 * assertions below by name, not just the total.
 *
 * ── What this deliberately does NOT measure ───────────────────────────────
 *
 * Pagination. The fixture resolves every page under PostgREST's 1000-row cap,
 * so `paginateAll` returns after one request per query. That is on purpose: the
 * structural depth of the graph is what a refactor regresses, and folding in
 * page counts would make the pin a function of fixture size. Chunking IS
 * measured — `chunked`/`chunkedPaginated` split on id count regardless of
 * response size and their chunk loops are serial, so the fixture deliberately
 * carries more than one chunk's worth of both companies and contacts.
 *
 * The browser-side sibling of this guard is `e2e/request-budget.spec.ts`, which
 * counts requests a real page load makes and cannot see depth at all. Neither
 * subsumes the other.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createRecordingClient,
  createRecordingState,
  type RecordedQuery,
  type RecordingState,
} from "@/mcp/__tests__/helpers/recording-client";
import {
  getCompanies,
  getCompanyDetail,
  setCompanyQueriesClient,
} from "@/lib/company-queries";
import { buildOutreachQueue } from "@/lib/outreach-queue";

const USER = "user-outreach";

// ── Wave harness ───────────────────────────────────────────────────────────

interface Release {
  table: string;
  wave: number;
}

/**
 * Parks every query until the driver releases it, counting releases as waves.
 *
 * `park()` is called when a query is AWAITED, not when its builder is built, so
 * a `Promise.all` over ten builders parks ten queries in the same wave while a
 * sequential await chain necessarily parks one per wave.
 */
class WaveGate {
  waves = 0;
  released: Release[] = [];
  private parked: Array<() => void> = [];

  park(table: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.parked.push(() => {
        // Recorded synchronously inside the release loop, where `waves` is
        // unambiguously the wave this query was let go in.
        this.released.push({ table, wave: this.waves });
        resolve();
      });
    });
  }

  /**
   * Drive `fn` to completion, releasing one wave at a time.
   *
   * The macrotask flush between waves is what makes the measurement honest: it
   * lets every continuation scheduled by the wave just released run and park
   * its own follow-up queries before the next wave is counted.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    let settled = false;
    const promise = fn().then(
      (v) => { settled = true; return v; },
      (e) => { settled = true; throw e; },
    );
    // Marks the rejection handled so a failure mid-drive surfaces from the
    // await at the end rather than as an unhandled rejection.
    promise.catch(() => {});
    for (;;) {
      await flushTasks();
      if (settled) break;
      if (this.parked.length === 0) {
        await flushTasks();
        // Nothing in flight and nothing resolved: the subject is waiting on
        // something this harness does not drive. Bail rather than hang.
        if (this.parked.length === 0 && !settled) break;
      }
      const batch = this.parked;
      this.parked = [];
      if (batch.length === 0) continue;
      this.waves += 1;
      for (const release of batch) release();
    }
    return promise;
  }
}

/** Let every already-queued microtask and macrotask continuation run. */
async function flushTasks(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Wrap a recording-client builder so its terminal operations park on the gate.
 *
 * A Proxy rather than a hand-copied double: the recording client's builder
 * returns ITSELF from every chain method, so a copy would have to re-wrap on
 * each link and would silently drop any method added to that helper later.
 */
function gateBuilder(inner: Record<string, unknown>, gate: WaveGate, table: string): unknown {
  return new Proxy(inner, {
    get(target, prop) {
      const value = (target as Record<string | symbol, unknown>)[prop];
      if (typeof value !== "function") return value;
      if (prop === "then") {
        const then = value as (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => unknown;
        return (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
          gate.park(table).then(() => then.call(target, (v) => v)).then(onF, onR);
      }
      if (prop === "single" || prop === "maybeSingle") {
        const settle = value as () => Promise<unknown>;
        return async () => {
          await gate.park(table);
          return settle.call(target);
        };
      }
      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        return result === target ? gateBuilder(inner, gate, table) : result;
      };
    },
  });
}

function gatedClient(state: RecordingState, gate: WaveGate) {
  const raw = createRecordingClient(state);
  return {
    from: (table: string) => gateBuilder(raw.from(table) as Record<string, unknown>, gate, table),
    rpc: (name: string, args?: Record<string, unknown>) =>
      gateBuilder(raw.rpc(name, args) as Record<string, unknown>, gate, `rpc:${name}`),
  } as unknown as Parameters<typeof setCompanyQueriesClient>[0];
}

// ── Fixture ────────────────────────────────────────────────────────────────

/**
 * Scale, and why each number is what it is.
 *
 * COMPANIES is over `chunked`'s 200-id chunk size so the company-keyed legs take
 * two chunks, and the contact total is over it so the contact-keyed legs take
 * three. At one chunk each, every serial chunk loop in the subject would
 * collapse to a single request and the depth pin would stop measuring the term
 * that scales with the size of the user's network — which is the term that made
 * the production measurement 32 deep.
 */
const COMPANIES = 260;
const CONTACTS_PER_COMPANY = 2;
/** Contacts at the ONE company /outreach opens — the detail-side population. */
const FOCUS_CONTACTS = 12;

const companyIds = Array.from({ length: COMPANIES }, (_, i) => 1000 + i);
const FOCUS_COMPANY = companyIds[0];

const employment = companyIds.flatMap((companyId, ci) =>
  Array.from({ length: ci === 0 ? FOCUS_CONTACTS : CONTACTS_PER_COMPANY }, (_, k) => ({
    id: companyId * 100 + k,
    company_id: companyId,
    contact_id: companyId * 1000 + k,
    is_current: true,
    title: "Product Manager",
    start_month: null,
    end_month: null,
    location_id: null,
    workplace_type: null,
    locations: null,
    contacts: {
      id: companyId * 1000 + k,
      user_id: USER,
      name: `Person ${companyId}-${k}`,
      photo_url: null,
      headline: "PM",
      persona: k === 0 ? "recruiter" : "product_peer",
      network_status: "prospect",
      stage_override: null,
      verified_school: null,
      review_note: null,
      last_scraped_at: null,
      import_meta: null,
      linkedin_url: null,
    },
  })),
);

const idsIn = (q: RecordedQuery, col: string): number[] | null => {
  const f = q.filters.find(([m, c]) => m === "in" && c === col);
  return f ? (f[2] as number[]) : null;
};
const eqValue = (q: RecordedQuery, col: string): unknown =>
  q.filters.find(([m, c]) => m === "eq" && c === col)?.[2];

/**
 * Fixture router. Routes on table PLUS projection/filters, because several legs
 * read the same table for different reasons — contact_emails is read three
 * times across the two functions and contact_companies three times, and routing
 * on the table alone would hand each of them the wrong rows.
 */
function route(q: RecordedQuery): unknown | undefined {
  switch (q.table) {
    case "users":
      return { university: "BYU" };

    case "target_companies": {
      // getCompanyDetail's single-row target read, vs getCompanies' scope sweep.
      if (q.resolution === "maybeSingle") {
        return { id: 90001, priority_score: 9, tier: "A", program_name: null, app_window_text: null, next_app_date: null, status: "researching" };
      }
      return companyIds.map((companyId, i) => ({
        id: 90000 + i,
        company_id: companyId,
        location_id: null,
        is_targeted: true,
        priority_score: COMPANIES - i,
        tier: "A",
        program_name: null,
        app_window_text: null,
        next_app_date: null,
        status: "researching",
        locations: null,
      }));
    }

    case "rpc:company_network_counts":
      return companyIds.map((companyId) => ({
        company_id: companyId,
        current_count: companyId === FOCUS_COMPANY ? FOCUS_CONTACTS : CONTACTS_PER_COMPANY,
        former_count: 0,
        bench_count: 0,
        current_prospect_count: companyId === FOCUS_COMPANY ? FOCUS_CONTACTS : CONTACTS_PER_COMPANY,
      }));

    case "companies": {
      if (q.resolution === "maybeSingle") {
        return { id: FOCUS_COMPANY, name: "Focus Co", logo_url: null, linkedin_url: null, universal_name: "focus" };
      }
      const ids = idsIn(q, "id") ?? [];
      return ids.map((id) => ({ id, name: `Company ${id}`, logo_url: null, linkedin_url: null }));
    }

    case "contact_companies": {
      // getCompanyDetail's roster read for ONE company.
      const single = eqValue(q, "company_id");
      if (single != null) return employment.filter((r) => r.company_id === single);
      // getCompanies' enrichment read over the shown companies.
      const byCompany = idsIn(q, "company_id");
      if (byCompany) {
        const set = new Set(byCompany);
        return employment.filter((r) => set.has(r.company_id));
      }
      // getCompanyDetail's "current employer" leg, keyed by contact.
      const byContact = new Set(idsIn(q, "contact_id") ?? []);
      return employment
        .filter((r) => byContact.has(r.contact_id))
        .map((r) => ({ contact_id: r.contact_id, title: r.title, companies: { id: r.company_id, name: `Company ${r.company_id}` } }));
    }

    case "contact_emails": {
      const ids = idsIn(q, "contact_id") ?? [];
      // The bounce leg filters .not("bounced_at","is",null) — nobody bounced.
      if (q.filters.some(([m, c]) => m === "not" && c === "bounced_at")) return [];
      return ids.map((contact_id) => ({
        contact_id,
        email: `p${contact_id}@example.com`,
        source: "verified",
        is_primary: true,
        bounced_at: null,
      }));
    }

    case "contact_schools": {
      const ids = idsIn(q, "contact_id") ?? [];
      return ids.map((contact_id) => ({ contact_id, schools: { name: contact_id % 3 === 0 ? "BYU" : "Other State" } }));
    }

    case "interactions": {
      const ids = idsIn(q, "contact_id") ?? [];
      return ids.slice(0, 5).map((contact_id) => ({ contact_id, interaction_type: "call", interaction_date: "2026-07-01" }));
    }

    case "email_message_contacts": {
      const ids = idsIn(q, "contact_id") ?? [];
      return ids.slice(0, 5).map((contact_id) => ({
        contact_id,
        email_messages: { user_id: USER, direction: "outbound", date: "2026-07-01", from_address: "me@example.com", is_simulated: false },
      }));
    }

    case "referrals":
    case "calendar_events":
    case "calendar_event_contacts":
    case "meeting_contacts":
      return [];

    case "company_locations":
      return [{ id: 1, location_id: 5, source: "manual", locations: { city: "Provo", state: "UT", country: "United States" } }];

    case "target_company_notes":
      return [{ id: 1, note: "Applications open in September", created_at: "2026-07-01", location_id: null, locations: null }];

    default:
      return undefined;
  }
}

// ── Harness plumbing ───────────────────────────────────────────────────────

let state: RecordingState;
let gate: WaveGate;

beforeEach(() => {
  state = createRecordingState();
  state.route = route;
  gate = new WaveGate();
  setCompanyQueriesClient(gatedClient(state, gate));
});

/** Wave-by-wave breakdown, so a failure says WHICH await came back. */
function waveReport(released: Release[]): string {
  const byWave = new Map<number, string[]>();
  for (const r of released) byWave.set(r.wave, [...(byWave.get(r.wave) ?? []), r.table]);
  return [...byWave.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([wave, tables]) => {
      const counts = new Map<string, number>();
      for (const t of tables) counts.set(t, (counts.get(t) ?? 0) + 1);
      const listed = [...counts].sort().map(([t, n]) => (n > 1 ? `${t} x${n}` : t)).join(", ");
      return `    wave ${wave}: ${listed}`;
    })
    .join("\n");
}

const tablesInWave = (released: Release[], wave: number) =>
  new Set(released.filter((r) => r.wave === wave).map((r) => r.table));

const waveDepth = (released: Release[]) => new Set(released.map((r) => r.wave)).size;

describe("/outreach query shape (CAR-229)", () => {
  it("getCompanyDetail is TWO waves deep, whatever the employee count", async () => {
    const detail = await gate.run(() => getCompanyDetail(USER, FOCUS_COMPANY));
    const { released } = gate;
    const report = waveReport(released);

    // The result still has to be right — a function that returns nothing is
    // trivially shallow.
    expect(detail?.current).toHaveLength(FOCUS_CONTACTS);
    expect(detail?.target?.notes).toHaveLength(1);
    expect(detail?.offices).toHaveLength(1);
    expect(detail?.current.every((p) => p.email != null)).toBe(true);
    expect(detail?.current.some((p) => p.is_alum)).toBe(true);
    expect(detail?.current.every((p) => p.stage != null)).toBe(true);

    // Wave 1: everything that depends on nothing. The viewer's school read is
    // named explicitly because it is the await this ticket found gating the
    // entire function while feeding only the alum badge at the very bottom.
    expect(tablesInWave(released, 1), `wave 1 lost a read:\n${report}`).toEqual(
      new Set(["users", "companies", "company_locations", "target_companies", "contact_companies"]),
    );

    // Wave 2: everything that depends on the roster — INCLUDING the eight
    // getContactStages legs, which used to be a third wave of their own, and
    // the target-notes read, which used to be a fourth.
    expect(tablesInWave(released, 2), `wave 2 lost a read:\n${report}`).toEqual(
      new Set([
        "contact_emails", "contact_schools", "interactions", "contact_companies",
        "email_message_contacts", "referrals", "calendar_events",
        "calendar_event_contacts", "meeting_contacts", "target_company_notes",
      ]),
    );

    expect(waveDepth(released), `getCompanyDetail is no longer 2 waves:\n${report}`).toBe(2);
  });

  it("the whole /outreach load stays flat", async () => {
    const summaries = await gate.run(() => getCompanies(USER, { scope: "targets", sort: "priority" }));
    const queueReleased = [...gate.released];
    const queueDepth = waveDepth(queueReleased);
    const { queue } = buildOutreachQueue(summaries, new Date().toISOString());
    expect(queue).toHaveLength(COMPANIES);
    // Enrichment is intact: the queue's ordering and the company cards read it.
    expect(summaries.every((c) => c.traction != null)).toBe(true);
    expect(summaries.some((c) => c.alum_count > 0)).toBe(true);
    expect(summaries.every((c) => c.recruiter_count === 1)).toBe(true);
    expect(summaries.every((c) => c.lead_contact_name != null)).toBe(true);

    const detail = await gate.run(() => getCompanyDetail(USER, queue[0].id));
    expect(detail?.current).toHaveLength(FOCUS_CONTACTS);

    const report = waveReport(gate.released);
    const total = state.recorded.length;

    /**
     * getCompanies is SEVEN waves at this fixture's scale, and each one is a
     * genuine dependency:
     *
     *   1  target_companies + users   (the viewer's school rides along)
     *   2  the counts RPC             (needs the target ids from wave 1)
     *   3  employment + companies     (chunk 1 of 2, both keyed on the same ids)
     *   4  employment + companies     (chunk 2 of 2)
     *   5-7 the stage/alum fan-out    (3 contact chunks of 200)
     *
     * Waves 3-4 and 5-7 are `chunked`'s serial chunk loop, which is why this
     * number tracks fixture size while getCompanyDetail's does not. Re-derive
     * rather than nudge: ceil(COMPANIES/200) + ceil(contacts/200) + 3.
     */
    expect(queueDepth, `getCompanies got deeper:\n${report}`).toBe(7);
    expect(waveDepth(gate.released), `/outreach got deeper:\n${report}`).toBe(9);

    // Count is the secondary instrument (see the header): it cannot see the
    // waterfall, but it does catch a leg that fans out per row. 52 measured;
    // the ceiling leaves room for one more batched read per function.
    expect(total, `/outreach request count:\n${report}`).toBeLessThanOrEqual(56);
  });
});
