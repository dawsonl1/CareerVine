/**
 * Deleting a company profile: the write shape, and the reads it must silence
 * (CAR-271).
 *
 * The integration tier owns the part that only real Postgres can prove — that a
 * bundle resync and a contact import cannot bring the company back, which rests
 * on a partial unique index and on SQL. This file owns the part that tier
 * cannot see cheaply: the exact columns the write touches, and the branch
 * `getCompanyDetail` takes for each of the three states its one target read now
 * has to distinguish.
 *
 * Those three states are the reason this file exists at all. The tombstone is
 * the SAME row that says "this is a target", so `is_targeted` and `is_deleted`
 * are read from the row rather than filtered in the WHERE, and the mapping is
 * easy to get subtly wrong in a way nothing else would catch:
 *
 *   targeted, not deleted  → page renders, target block present
 *   untargeted, not deleted → page renders, target block ABSENT
 *   deleted                 → page does not render at all (null, i.e. 404)
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createRecordingClient,
  createRecordingState,
  type RecordedQuery,
  type RecordingState,
} from "@/mcp/__tests__/helpers/recording-client";
import {
  deleteCompanyForUser,
  getCompanyDetail,
  setCompanyQueriesClient,
} from "@/lib/company-queries";

const USER = "user-del";
const COMPANY = 42;

let state: RecordingState;

/** Filter lookup by method + column, returning the literal. */
const filterVal = (q: RecordedQuery, method: string, col: string): unknown => {
  const f = q.filters.find(([m, c]) => m === method && c === col);
  return f ? f[2] : undefined;
};

const writes = (table: string, op: string) =>
  state.recorded.filter((q) => q.table === table && q.op === op);

function install(route: (q: RecordedQuery) => unknown) {
  state = createRecordingState();
  state.route = route as (q: unknown) => unknown;
  setCompanyQueriesClient(
    createRecordingClient(state) as unknown as Parameters<typeof setCompanyQueriesClient>[0],
  );
}

describe("deleteCompanyForUser", () => {
  it("flags every scope row, so office pipelines go with the company", () => {
    // One update, no id list: the company's office scopes are marked by the same
    // predicate as its company-wide row. This is what lets every read filter
    // with a plain .eq("is_deleted", false) instead of having to work out which
    // row for this company is the tombstone.
    install((q) => (q.table === "target_companies" ? { id: 7 } : undefined));

    return deleteCompanyForUser(USER, COMPANY).then(() => {
      const [update] = writes("target_companies", "update");
      expect(update.payload).toMatchObject({ is_deleted: true });
      expect(filterVal(update, "eq", "user_id")).toBe(USER);
      expect(filterVal(update, "eq", "company_id")).toBe(COMPANY);
      // Deliberately NOT scoped to location_id: office rows are included.
      expect(filterVal(update, "is", "location_id")).toBeUndefined();
    });
  });

  it("does not touch the contacts, their employment, or the global company row", async () => {
    // The locked decision, asserted as an absence. Deleting a company profile is
    // not a way to delete people, and `companies` is a GLOBAL table — a write
    // there would reach into every other tenant's data.
    install((q) => (q.table === "target_companies" ? { id: 7 } : undefined));

    await deleteCompanyForUser(USER, COMPANY);

    const touched = new Set(state.recorded.map((q) => q.table));
    expect(touched).toEqual(new Set(["target_companies"]));
  });

  it("mints a tombstone when the company only ever appeared through contacts", async () => {
    // No company-wide row exists: the company reached the list purely because
    // someone in the network works there. The row has to be CREATED, because a
    // company with no row is exactly what every recreate path reads as "not
    // seen yet" and re-adds.
    install((q) => {
      if (q.table === "target_companies" && q.resolution === "maybeSingle") return null;
      return undefined;
    });

    await deleteCompanyForUser(USER, COMPANY);

    const [insert] = writes("target_companies", "insert");
    expect(insert.payload).toMatchObject({
      user_id: USER,
      company_id: COMPANY,
      is_deleted: true,
      // Not a target: a tombstone must never read as something being pursued.
      is_targeted: false,
    });
  });

  it("is idempotent — deleting an already-deleted company inserts nothing", async () => {
    // The probe deliberately sees tombstones, so a second delete finds the row
    // and takes the update path. Were it filtered, this would take the insert
    // branch and raise 23505 against the partial unique index.
    install((q) => {
      if (q.table === "target_companies" && q.resolution === "maybeSingle") return { id: 7 };
      return undefined;
    });

    await deleteCompanyForUser(USER, COMPANY);

    expect(writes("target_companies", "insert")).toHaveLength(0);
  });
});

describe("getCompanyDetail and the three states of the company-wide row", () => {
  /**
   * Routes the whole detail fan-out. Only the target row varies between cases;
   * everything else answers with the shape the function expects so the branch
   * under test is the only thing that can change the outcome.
   */
  function installDetail(targetRow: unknown) {
    install((q: RecordedQuery) => {
      switch (q.table) {
        case "companies":
          return { id: COMPANY, name: "Acme", logo_url: null, linkedin_url: null, universal_name: null };
        case "target_companies":
          return targetRow;
        case "users":
          return { university: null };
        case "target_company_notes":
          return [{ id: 1, note: "n", created_at: "2026-01-01", location_id: null, locations: null }];
        default:
          return [];
      }
    });
  }

  const LIVE_TARGET = {
    id: 90,
    priority_score: 5,
    program_name: null,
    app_window_text: null,
    next_app_date: null,
    status: "researching",
    is_targeted: true,
    is_deleted: false,
  };

  it("renders with a target block when the company is targeted", async () => {
    installDetail(LIVE_TARGET);
    const detail = await getCompanyDetail(USER, COMPANY);
    expect(detail).not.toBeNull();
    expect(detail?.target?.id).toBe(90);
  });

  it("still renders, without a target block, when merely untargeted", async () => {
    // The distinction the WHERE clause used to express. Untargeted is NOT
    // deleted: "Not a target" is a company you can still open and read.
    installDetail({ ...LIVE_TARGET, is_targeted: false });
    const detail = await getCompanyDetail(USER, COMPANY);
    expect(detail).not.toBeNull();
    expect(detail?.target).toBeNull();
  });

  it("returns null when deleted, which is the page's not-found path", async () => {
    installDetail({ ...LIVE_TARGET, is_deleted: true });
    expect(await getCompanyDetail(USER, COMPANY)).toBeNull();
  });

  it("stops before the second wave when deleted, rather than assembling a page nobody renders", async () => {
    installDetail({ ...LIVE_TARGET, is_deleted: true });
    await getCompanyDetail(USER, COMPANY);

    // Wave 2 is keyed off the roster. Its tables must never be reached: a
    // deleted company should cost one round trip, not two.
    const tables = new Set(state.recorded.map((q) => q.table));
    expect(tables.has("contact_emails")).toBe(false);
    expect(tables.has("target_company_notes")).toBe(false);
  });

  it("reads is_deleted rather than filtering it, or deleted and untargeted collapse", async () => {
    // Falsification guard for the two tests above. If a future change moves
    // is_deleted back into the WHERE, both states return no row, "untargeted"
    // becomes indistinguishable from "deleted", and one of them is silently
    // wrong. Pin the projection instead of the outcome.
    installDetail(LIVE_TARGET);
    await getCompanyDetail(USER, COMPANY);

    const targetRead = state.recorded.find(
      (q) => q.table === "target_companies" && q.op === "select",
    );
    expect(targetRead?.selectCols).toContain("is_deleted");
    expect(targetRead?.selectCols).toContain("is_targeted");
    expect(filterVal(targetRead!, "eq", "is_deleted")).toBeUndefined();
    expect(filterVal(targetRead!, "eq", "is_targeted")).toBeUndefined();
  });
});

beforeEach(() => {
  state = createRecordingState();
});
