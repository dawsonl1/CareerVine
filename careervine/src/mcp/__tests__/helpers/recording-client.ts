/**
 * Recording Supabase client for the MCP scoping gate (CAR-151).
 *
 * Every .from() chain and .rpc() call is recorded — operation kind, filters,
 * mutation payloads — and resolved from a programmable fixture router, so a
 * test can drive a data function end-to-end and then assert that every query
 * it issued was scoped to the operating user.
 *
 * Response routing: `route(ctx)` may return data for a query; returning
 * `undefined` falls back to defaults — `[]` for awaited lists, `null` for
 * single()/maybeSingle() reads, and `{ id: <auto>, ...payload }` for
 * insert().select().single() so create flows run without per-entry fixtures.
 */

export interface RecordedQuery {
  table: string;
  /** Primary operation: select | insert | update | upsert | delete | rpc. */
  op: string;
  /** How the chain resolved: await | single | maybeSingle. */
  resolution: string;
  /** rpc name when op === "rpc". */
  rpc?: string;
  /** rpc args when op === "rpc". */
  rpcArgs?: Record<string, unknown>;
  /** Filter calls in order: [method, column, value]. */
  filters: Array<[string, string, unknown]>;
  /** .or() raw filter strings. */
  orFilters: string[];
  /** Insert/update/upsert payload (object or array of objects). */
  payload?: unknown;
  /** Whether { count: "exact" } was requested on the op. */
  countRequested: boolean;
  /** Whether { head: true } was requested on select. */
  headRequested: boolean;
  /** order() columns in call order. */
  orders: string[];
  /**
   * The raw select() column string. Load-bearing for scoping: a filter on an
   * embedded column only restricts PARENT rows when the embed is declared
   * !inner, so the checker has to read this to tell real scoping from a no-op.
   */
  selectCols?: string;
  /** The data this query resolved with (fixture or default). */
  returned?: unknown;
  /** Row count the query resolved with (count-based CAS proves a match). */
  returnedCount?: number | null;
}

export type RouteCtx = RecordedQuery;

export type FixtureRouter = (ctx: RouteCtx) => unknown | undefined;

export interface RecordingState {
  recorded: RecordedQuery[];
  route: FixtureRouter;
  nextId: number;
}

export function createRecordingState(): RecordingState {
  return { recorded: [], route: () => undefined, nextId: 100 };
}

function resolveQuery(state: RecordingState, q: RecordedQuery) {
  state.recorded.push(q);
  const finish = (result: { data: unknown; error: null; count: number | null }) => {
    q.returned = result.data;
    q.returnedCount = result.count;
    return result;
  };
  const routed = state.route(q);
  if (routed !== undefined) {
    return finish({ data: routed, error: null, count: Array.isArray(routed) ? routed.length : routed != null ? 1 : 0 });
  }
  if (q.op === "insert" && q.resolution === "single") {
    const payload = Array.isArray(q.payload) ? q.payload[0] : q.payload;
    return finish({ data: { id: state.nextId++, ...(payload as Record<string, unknown>) }, error: null, count: 1 });
  }
  if (q.resolution === "single" || q.resolution === "maybeSingle") {
    return finish({ data: null, error: null, count: 0 });
  }
  // Mutations resolve with a count so count-based CAS callers see success.
  if (q.op !== "select" && q.op !== "rpc") {
    return finish({ data: null, error: null, count: 1 });
  }
  return finish({ data: [], error: null, count: 0 });
}

function makeBuilder(state: RecordingState, table: string, op: string, payload?: unknown, opts?: { count?: string; head?: boolean }) {
  const q: RecordedQuery = {
    table,
    op,
    resolution: "await",
    filters: [],
    orFilters: [],
    payload,
    countRequested: opts?.count === "exact",
    headRequested: Boolean(opts?.head),
    orders: [],
  };
  const filter = (method: string) => (col: string, val?: unknown) => {
    q.filters.push([method, col, val]);
    return builder;
  };
  const builder: Record<string, unknown> = {
    select: (cols?: string, selOpts?: { count?: string; head?: boolean }) => {
      if (cols != null) q.selectCols = cols;
      if (selOpts?.count === "exact") q.countRequested = true;
      if (selOpts?.head) q.headRequested = true;
      return builder;
    },
    insert: (p: unknown) => { q.op = "insert"; q.payload = p; return builder; },
    update: (p: unknown, uOpts?: { count?: string }) => {
      q.op = "update"; q.payload = p;
      if (uOpts?.count === "exact") q.countRequested = true;
      return builder;
    },
    upsert: (p: unknown, uOpts?: { count?: string; onConflict?: string; ignoreDuplicates?: boolean }) => {
      q.op = "upsert"; q.payload = p;
      if (uOpts?.count === "exact") q.countRequested = true;
      return builder;
    },
    delete: () => { q.op = "delete"; return builder; },
    eq: filter("eq"), neq: filter("neq"), gt: filter("gt"), gte: filter("gte"),
    lt: filter("lt"), lte: filter("lte"), like: filter("like"), ilike: filter("ilike"),
    is: filter("is"), in: filter("in"), contains: filter("contains"),
    // PostgREST's .not() is (column, operator, value) — record the VALUE, not
    // the operator, so an id referenced through .not() is still checkable.
    not: (col: string, _op: string, val?: unknown) => { q.filters.push(["not", col, val]); return builder; },
    or: (expr: string) => { q.orFilters.push(expr); return builder; },
    order: (col: string) => { q.orders.push(col); return builder; },
    limit: () => builder,
    range: () => builder,
    single: async () => { q.resolution = "single"; return resolveQuery(state, q); },
    maybeSingle: async () => { q.resolution = "maybeSingle"; return resolveQuery(state, q); },
    then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(resolveQuery(state, q)).then(onF, onR),
  };
  return builder;
}

/** A client whose .from()/.rpc() record into `state` and resolve via its router. */
export function createRecordingClient(state: RecordingState) {
  return {
    from: (table: string) => makeBuilder(state, table, "select"),
    rpc: (name: string, args?: Record<string, unknown>) => {
      const q: RecordedQuery = {
        table: `rpc:${name}`,
        op: "rpc",
        resolution: "await",
        rpc: name,
        rpcArgs: args,
        filters: [],
        orFilters: [],
        countRequested: false,
        headRequested: false,
        orders: [],
      };
      const builder: Record<string, unknown> = {
        single: async () => { q.resolution = "single"; return resolveQuery(state, q); },
        maybeSingle: async () => { q.resolution = "maybeSingle"; return resolveQuery(state, q); },
        then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
          Promise.resolve(resolveQuery(state, q)).then(onF, onR),
      };
      return builder;
    },
  };
}

// ── Scoping assertions ─────────────────────────────────────────────────

/**
 * Cross-user tables where unscoped access is deliberate. Each entry carries
 * the justification the gate requires (F10): these are global normalization
 * tables shared by every user's graph, holding no per-user data.
 */
export const GLOBAL_TABLES: Record<string, string> = {
  schools: "global normalization table — school rows are shared across users; membership in a user's graph lives in contact_schools",
  companies: "global normalization table — company rows are shared across users; membership lives in contact_companies / target_companies",
  locations: "global normalization table — canonical city/state/country rows shared across users",
};

/**
 * Tables that carry their own user_id column (derived from the migration
 * history, not from constants.ts). Embedding one of these from a parent that
 * is NOT itself user-scoped means the embed is the only thing standing between
 * the query and another tenant's rows — the CAR-133 / R2.1 case, where a bad
 * calendar_event_contacts link would have surfaced a foreign contact's name.
 * Child and junction tables are absent by design: they have no user_id and are
 * scoped transitively by an already-scoped parent row.
 */
const USER_OWNED_TABLES = new Set([
  "ai_follow_up_drafts", "attachments", "bundle_contact_state", "bundle_subscriptions",
  "calendar_events", "contact_change_events", "contact_scrape_snapshots", "contacts",
  "discovery_candidates", "email_drafts", "email_follow_ups", "email_messages",
  "email_templates", "follow_up_action_items", "gmail_connections", "meetings",
  "referrals", "scheduled_emails", "suppressed_imports", "tags", "target_companies",
  "user_companies", "user_schools",
]);

/** Relations embedded by a select string, e.g. "a, contacts!inner(id), tags(*)" -> [contacts, tags]. */
function embeddedRelations(selectCols: string | undefined): string[] {
  if (!selectCols) return [];
  const rels: string[] = [];
  for (const m of selectCols.matchAll(/(\w+)(!inner)?\s*\(/g)) rels.push(m[1]);
  return rels;
}

function payloadCarriesUser(payload: unknown, userId: string): boolean {
  if (payload == null) return false;
  const rows = Array.isArray(payload) ? payload : [payload];
  return rows.length > 0 && rows.every((r) => (r as Record<string, unknown>).user_id === userId);
}

/**
 * Directly user-scoped: .eq on user_id, an embedded <rel>.user_id backed by a
 * `<rel>!inner` embed, or a payload stamped with user_id.
 *
 * The !inner requirement is not pedantry. In PostgREST a filter on an embedded
 * column restricts the PARENT rows only when the embed is an inner join;
 * without it the parent row is still returned with the embed nulled, so
 * `.eq("contacts.user_id", uid)` silently becomes a no-op and the query reads
 * every tenant's rows. Dropping `!inner` from a select string produces no type
 * error and no lint error, so this check is the only thing standing between
 * that edit and a cross-tenant read (CAR-151 review).
 */
export function isDirectlyScoped(q: RecordedQuery, userId: string): boolean {
  const scopedFilter = q.filters.some(([method, col, val]) => {
    if (method !== "eq" || val !== userId) return false;
    if (col === "user_id") return true;
    if (!col.endsWith(".user_id")) return false;
    const rel = col.slice(0, -".user_id".length);
    return (q.selectCols ?? "").includes(`${rel}!inner`);
  });
  if (scopedFilter) return true;
  if ((q.op === "insert" || q.op === "upsert") && payloadCarriesUser(q.payload, userId)) return true;
  return false;
}

export interface OwnershipSpec {
  /**
   * Rpc names permitted under the ownership umbrella (an rpc bypasses the
   * query builder, so scoping can't be observed — it must key on an id an
   * earlier user-scoped query in the same invocation established).
   */
  allowedRpcs?: string[];
}

// user_id is deliberately excluded: it identifies the TENANT, not a row this
// invocation proved it owns. Counting it as an "id" was what let the owned set
// become non-empty after any scoped query and opened the vacuous-pass hole.
const ID_COLUMNS = /(^|_)id$/;
const isRowIdColumn = (col: string) => ID_COLUMNS.test(col) && col !== "user_id" && !col.endsWith(".user_id");

/** Ids an .or() expression constrains, e.g. "contact_id.eq.5,contact_id.eq.9". */
function orExpressionIds(orFilters: string[]): Array<{ col: string; val: string }> {
  const refs: Array<{ col: string; val: string }> = [];
  for (const expr of orFilters) {
    for (const clause of expr.split(",")) {
      const m = clause.trim().match(/^([A-Za-z0-9_.]+)\.(?:eq|in)\.(.+)$/);
      if (m && isRowIdColumn(m[1])) refs.push({ col: m[1], val: m[2] });
    }
  }
  return refs;
}

/**
 * True when EVERY row-id this operation references is an owned id, AND it
 * references at least one. The "at least one" requirement is the point: an
 * operation constrained only by non-id columns (status, dates, booleans) proves
 * nothing about tenancy, and previously passed vacuously because both loops
 * below simply found nothing to reject (CAR-151 review).
 */
function usesOnlyOwnedKeys(q: RecordedQuery, owned: Set<number | string>): boolean {
  let sawOwnedKey = false;
  const check = (val: unknown): boolean => {
    for (const v of Array.isArray(val) ? val : [val]) {
      if (v == null) continue;
      if (!owned.has(v as number | string)) return false;
      sawOwnedKey = true;
    }
    return true;
  };

  for (const [, col, val] of q.filters) {
    if (!isRowIdColumn(col)) continue;
    if (!check(val)) return false;
  }
  // Ids hidden inside .or() are checked too — leaving them unexamined made them
  // pass silently, which is the unsafe direction.
  for (const ref of orExpressionIds(q.orFilters)) {
    const parsed: number | string = /^\d+$/.test(ref.val) ? Number(ref.val) : ref.val;
    if (!check(parsed)) return false;
  }
  if (q.payload != null) {
    const rows = Array.isArray(q.payload) ? q.payload : [q.payload];
    for (const row of rows) {
      for (const [key, val] of Object.entries(row as Record<string, unknown>)) {
        if (!isRowIdColumn(key) || val == null) continue;
        if (!check(val)) return false;
      }
    }
  }
  return sawOwnedKey;
}

function returnedIds(returned: unknown): Array<number | string> {
  if (returned == null) return [];
  const rows = Array.isArray(returned) ? returned : [returned];
  return rows
    .map((r) => (r as Record<string, unknown>)?.id)
    .filter((id): id is number | string => id != null);
}

/**
 * Row ids a directly-scoped MUTATION proved it owns. A scoped update/delete
 * that matched (count > 0) is proof the filtered row belongs to the user, which
 * is how count-based CAS flows (rule 17) establish ownership without a
 * read-back. Reads do NOT get this treatment: filtering on an id proves nothing
 * unless a row actually came back, and treating filters as proof made ownership
 * circular for any function handed ids by its caller (CAR-151 review).
 */
function matchedMutationIds(q: RecordedQuery): Array<number | string> {
  const isMutation = q.op === "update" || q.op === "delete" || q.op === "upsert";
  if (!isMutation || !(q.returnedCount ?? 0)) return [];
  const ids: Array<number | string> = [];
  for (const [, col, val] of q.filters) {
    if (!isRowIdColumn(col)) continue;
    for (const v of Array.isArray(val) ? val : [val]) if (v != null) ids.push(v as number | string);
  }
  return ids;
}

/**
 * Assert every recorded query is user-scoped: directly (user_id filter /
 * payload), via a global-table allowlist entry, or keyed exclusively on ids
 * this invocation PROVED it owns.
 *
 * The owned set is built as the invocation runs, and only from evidence:
 *  - rows a directly user-scoped query actually RETURNED,
 *  - rows a directly user-scoped mutation actually MATCHED (count > 0), and
 *  - ids from global-table queries (those rows carry no tenant data).
 * Filtering on an id is deliberately NOT evidence — see matchedMutationIds.
 *
 * Deleting a .eq("user_id") upstream therefore cascades: the op itself is
 * flagged, and every child op that depended on it for ownership is too.
 */
export function assertAllScoped(
  recorded: RecordedQuery[],
  userId: string,
  ownership?: OwnershipSpec,
): void {
  const owned = new Set<number | string>();
  const failures: string[] = [];
  for (const q of recorded) {
    if (q.op === "rpc") {
      const allowed = ownership?.allowedRpcs?.includes(q.rpc ?? "");
      const argsOwned = Object.values(q.rpcArgs ?? {}).some((v) => owned.has(v as number | string));
      if (!allowed || !argsOwned) {
        failures.push(`rpc ${q.rpc}(${JSON.stringify(q.rpcArgs)}) is not covered by an ownership assertion`);
      }
      continue;
    }
    if (q.table in GLOBAL_TABLES) {
      for (const id of returnedIds(q.returned)) owned.add(id);
      continue;
    }
    if (isDirectlyScoped(q, userId)) {
      for (const id of returnedIds(q.returned)) owned.add(id);
      for (const id of matchedMutationIds(q)) owned.add(id);
      continue;
    }
    if (usesOnlyOwnedKeys(q, owned)) {
      // Ownership by key covers the PARENT rows, but says nothing about a
      // user-owned table pulled in through an embed: the junction row that
      // links them may itself be bad. Each such embed needs its own scoping.
      const unscopedEmbeds = embeddedRelations(q.selectCols).filter(
        (rel) =>
          USER_OWNED_TABLES.has(rel) &&
          !q.filters.some(([m, col, val]) => m === "eq" && col === `${rel}.user_id` && val === userId),
      );
      if (unscopedEmbeds.length > 0) {
        failures.push(
          `${q.op} on "${q.table}" is keyed on owned ids but embeds user-owned ${unscopedEmbeds.join(", ")} without .eq("<rel>.user_id") — a bad link row would surface another tenant's data`,
        );
        continue;
      }
      // Ownership-covered — and any rows it returned are the user's too
      // (they were reached exclusively through owned keys).
      for (const id of returnedIds(q.returned)) owned.add(id);
      continue;
    }
    failures.push(`${q.op} on "${q.table}" (filters: ${JSON.stringify(q.filters)}) is not user-scoped`);
  }
  if (failures.length > 0) {
    throw new Error(`Unscoped service-role queries:\n  - ${failures.join("\n  - ")}`);
  }
}
