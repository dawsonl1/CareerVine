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
  /** The data this query resolved with (fixture or default). */
  returned?: unknown;
}

export interface RouteCtx extends RecordedQuery {}

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
    select: (_cols?: string, selOpts?: { count?: string; head?: boolean }) => {
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
    is: filter("is"), in: filter("in"), not: filter("not"), contains: filter("contains"),
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

function payloadCarriesUser(payload: unknown, userId: string): boolean {
  if (payload == null) return false;
  const rows = Array.isArray(payload) ? payload : [payload];
  return rows.length > 0 && rows.every((r) => (r as Record<string, unknown>).user_id === userId);
}

/** Directly user-scoped: .eq on user_id / an embedded *.user_id, or a payload stamped with user_id. */
export function isDirectlyScoped(q: RecordedQuery, userId: string): boolean {
  const scopedFilter = q.filters.some(
    ([method, col, val]) =>
      method === "eq" && (col === "user_id" || col.endsWith(".user_id")) && val === userId,
  );
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

const ID_COLUMNS = /(^|_)id$/;

function usesOnlyOwnedKeys(q: RecordedQuery, owned: Set<number | string>): boolean {
  // A child operation is ownership-covered when every id-bearing filter or
  // payload reference points at an owned id. Non-id filters (status, dates,
  // booleans, snooze windows) are unconstrained.
  for (const [, col, val] of q.filters) {
    if (!ID_COLUMNS.test(col)) continue;
    const vals = Array.isArray(val) ? val : [val];
    if (!vals.every((v) => owned.has(v as number | string))) return false;
  }
  if (q.payload != null) {
    const rows = Array.isArray(q.payload) ? q.payload : [q.payload];
    for (const row of rows) {
      for (const [key, val] of Object.entries(row as Record<string, unknown>)) {
        if (!ID_COLUMNS.test(key) || key === "user_id" || val == null) continue;
        if (!owned.has(val as number | string)) return false;
      }
    }
  }
  return true;
}

function returnedIds(returned: unknown): Array<number | string> {
  if (returned == null) return [];
  const rows = Array.isArray(returned) ? returned : [returned];
  return rows
    .map((r) => (r as Record<string, unknown>)?.id)
    .filter((id): id is number | string => id != null);
}

function filteredIds(q: RecordedQuery): Array<number | string> {
  const ids: Array<number | string> = [];
  for (const [, col, val] of q.filters) {
    if (!ID_COLUMNS.test(col)) continue;
    for (const v of Array.isArray(val) ? val : [val]) {
      if (v != null) ids.push(v as number | string);
    }
  }
  return ids;
}

/**
 * Assert every recorded query is user-scoped: directly (user_id filter /
 * payload), via a global-table allowlist entry, or keyed exclusively on
 * OWNED ids.
 *
 * The owned set is built as the invocation runs — membership IS the
 * ownership assertion:
 *  - ids a directly user-scoped query filtered on or returned (a scoped
 *    read/write proves those rows are the user's), and
 *  - ids returned by global-table queries (they carry no tenant data).
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
      for (const id of filteredIds(q)) owned.add(id);
      for (const id of returnedIds(q.returned)) owned.add(id);
      continue;
    }
    if (owned.size > 0 && usesOnlyOwnedKeys(q, owned)) {
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
