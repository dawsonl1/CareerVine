/**
 * Test fixtures for the Gmail sync path (CAR-153).
 *
 * `createFakeGmail` — a configurable stand-in for the @googleapis/gmail client:
 * `messages.list` serves multi-page results via nextPageToken (with per-page
 * failure injection and awaitable gates for concurrency tests), `messages.get`
 * builds metadata payloads from parameterized From/To/Subject/Date, and
 * `users.settings.sendAs.list` serves a configurable alias set.
 *
 * `createFakeSyncDb` — a small in-memory Supabase service-client double that
 * actually executes the filter chains the sync code issues (eq / in / is /
 * contains / joined-column eq), applies updates/upserts to seeded rows, and
 * records every operation so tests can assert on exactly what was written.
 * Together they drive the REAL `syncEmailsForContact` loop end-to-end through
 * persistence and attribution.
 */

export interface FakeGmailMessage {
  id: string;
  threadId?: string;
  from?: string;
  to?: string;
  subject?: string;
  /** Raw Date header value (can be deliberately malformed). */
  date?: string;
  snippet?: string;
  labelIds?: string[];
  /** Extra metadata headers, e.g. { "X-Failed-Recipients": "a@b.c" }. */
  extraHeaders?: Record<string, string>;
}

export interface FakeGmailOptions {
  /** Pages served by messages.list, in order, per pagination chain. */
  pages?: FakeGmailMessage[][];
  /** 0-based page indexes whose list call throws (mutable between runs). */
  failOnListPages?: Set<number>;
  /** Error factory for injected failures. */
  makeError?: () => Error;
  /**
   * Awaitable gate per list call: given the query string, return a promise the
   * call awaits before resolving (or undefined for no gate). Lets tests hold
   * specific contacts' syncs in flight to pin pool/ordering behavior.
   */
  listGate?: (q: string) => Promise<void> | undefined;
  /** Aliases served by users.settings.sendAs.list. */
  sendAsAliases?: string[];
  /** Threads served by users.threads.get, keyed by thread id. */
  threads?: Record<string, { from: string; internalDate?: string }[]>;
}

export function createFakeGmail(options: FakeGmailOptions = {}) {
  const state = {
    listCalls: [] as { q: string; pageToken?: string }[],
    getCalls: [] as string[],
    inFlightListCalls: 0,
    maxInFlightListCalls: 0,
  };

  const allMessages = () => (options.pages ?? []).flat();

  const gmail = {
    users: {
      messages: {
        list: async (args: { q?: string; pageToken?: string; maxResults?: number }) => {
          state.listCalls.push({ q: args.q ?? "", pageToken: args.pageToken });
          state.inFlightListCalls++;
          state.maxInFlightListCalls = Math.max(state.maxInFlightListCalls, state.inFlightListCalls);
          try {
            const gate = options.listGate?.(args.q ?? "");
            if (gate) await gate;

            const pages = options.pages ?? [[]];
            const pageIndex = args.pageToken ? parseInt(args.pageToken.replace("page-", ""), 10) : 0;
            if (options.failOnListPages?.has(pageIndex)) {
              throw (options.makeError ?? (() => new Error(`injected list failure on page ${pageIndex}`)))();
            }
            const page = pages[pageIndex] ?? [];
            const hasMore = pageIndex + 1 < pages.length;
            return {
              data: {
                messages: page.map((m) => ({ id: m.id })),
                ...(hasMore ? { nextPageToken: `page-${pageIndex + 1}` } : {}),
              },
            };
          } finally {
            state.inFlightListCalls--;
          }
        },
        get: async (args: { id: string }) => {
          state.getCalls.push(args.id);
          const msg = allMessages().find((m) => m.id === args.id);
          if (!msg) throw new Error(`fake-gmail: no message ${args.id}`);
          const headers: { name: string; value: string }[] = [];
          if (msg.from) headers.push({ name: "From", value: msg.from });
          if (msg.to) headers.push({ name: "To", value: msg.to });
          if (msg.subject !== undefined) headers.push({ name: "Subject", value: msg.subject });
          if (msg.date !== undefined) headers.push({ name: "Date", value: msg.date });
          for (const [name, value] of Object.entries(msg.extraHeaders ?? {})) {
            headers.push({ name, value });
          }
          return {
            data: {
              id: msg.id,
              threadId: msg.threadId ?? null,
              snippet: msg.snippet ?? "",
              labelIds: msg.labelIds ?? [],
              payload: { headers },
            },
          };
        },
      },
      threads: {
        get: async (args: { id: string }) => ({
          data: {
            messages: (options.threads?.[args.id] ?? []).map((m) => ({
              internalDate: m.internalDate ?? String(Date.now()),
              payload: { headers: [{ name: "From", value: m.from }] },
            })),
          },
        }),
      },
      settings: {
        sendAs: {
          list: async () => ({
            data: {
              sendAs: (options.sendAsAliases ?? []).map((sendAsEmail) => ({ sendAsEmail })),
            },
          }),
        },
      },
    },
  };

  return { gmail, state, options };
}

// ── In-memory Supabase service-client double ───────────────────────────

type Row = Record<string, unknown>;

export interface DbOp {
  table: string;
  op: "select" | "update" | "upsert";
  values?: Row;
  filters: [string, unknown][];
}

/** Resolve possibly-nested column refs like "contacts.user_id" on a row. */
function readColumn(row: Row, col: string): unknown {
  if (!col.includes(".")) return row[col];
  let current: unknown = row;
  for (const part of col.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Row)[part];
  }
  return current;
}

export function createFakeSyncDb(
  seed: Partial<Record<string, Row[]>> = {},
  opts: {
    /**
     * Inject a DB error on matching operations (e.g. to prove the sync
     * completion gate holds the watermark when a junction write fails).
     * Return an error message to fail the op, or null/undefined to let it run.
     */
    failOn?: (table: string, op: DbOp["op"]) => string | null | undefined;
  } = {},
) {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(seed)) {
    tables[name] = (rows ?? []).map((r) => ({ ...r }));
  }
  const ops: DbOp[] = [];

  // SERIAL-column stand-in: rows inserted without an id get a per-table
  // auto-increment, seeded past any explicit ids, so code that reads back
  // generated ids (e.g. the CAR-159 junction link inserts) works end-to-end.
  const idCounters: Record<string, number> = {};
  const nextId = (table: string) => {
    idCounters[table] ??= Math.max(
      0,
      ...tables[table].map((r) => (typeof r.id === "number" ? (r.id as number) : 0))
    );
    return ++idCounters[table];
  };

  function from(table: string) {
    tables[table] ??= [];
    let op: DbOp["op"] = "select";
    let updateValues: Row | undefined;
    let upsertRows: Row[] = [];
    let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
    const filters: [string, unknown][] = [];
    const eqFilters: [string, unknown][] = [];
    const inFilters: [string, unknown[]][] = [];
    const isFilters: [string, unknown][] = [];
    const containsFilters: [string, unknown[]][] = [];
    const gtFilters: [string, number][] = [];
    let orderCol: string | null = null;
    let orderAsc = true;
    let limitN: number | null = null;
    let rangeFrom = 0;
    let insertedThisCall: Row[] = [];

    const matches = (row: Row) =>
      eqFilters.every(([c, v]) => readColumn(row, c) === v) &&
      inFilters.every(([c, vs]) => vs.includes(readColumn(row, c))) &&
      isFilters.every(([c, v]) => (v === null ? readColumn(row, c) == null : readColumn(row, c) === v)) &&
      containsFilters.every(([c, vs]) => {
        const cell = readColumn(row, c);
        return Array.isArray(cell) && vs.every((v) => cell.includes(v));
      }) &&
      gtFilters.every(([c, v]) => (readColumn(row, c) as number) > v);

    const execute = () => {
      const failMsg = opts.failOn?.(table, op);
      if (failMsg) {
        ops.push({ table, op, filters: [...filters] });
        return { data: null, error: { message: failMsg }, count: null };
      }
      if (op === "upsert") {
        const conflictCols = (upsertOpts.onConflict ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        insertedThisCall = [];
        for (const row of upsertRows) {
          const conflict = tables[table].find((existing) =>
            conflictCols.length > 0 && conflictCols.every((c) => existing[c] === row[c])
          );
          if (conflict) {
            // ignoreDuplicates:true is ON CONFLICT DO NOTHING — the conflicting
            // row is not in RETURNING. ignoreDuplicates:false is merge-duplicates
            // (ON CONFLICT DO UPDATE): PostgREST returns the updated row in the
            // representation, so it MUST be part of RETURNING here too — the
            // sent-message cache upsert reads its id back through this path.
            if (!upsertOpts.ignoreDuplicates) {
              Object.assign(conflict, row);
              insertedThisCall.push(conflict);
            }
            continue;
          }
          const copy = { ...row };
          if (copy.id === undefined) copy.id = nextId(table);
          tables[table].push(copy);
          insertedThisCall.push(copy);
        }
        ops.push({ table, op, values: { count: upsertRows.length } as Row, filters: [...filters] });
        return { data: insertedThisCall, error: null, count: insertedThisCall.length };
      }

      let rows = tables[table].filter(matches);
      if (op === "update") {
        for (const row of rows) Object.assign(row, updateValues);
        ops.push({ table, op, values: updateValues, filters: [...filters] });
        return { data: rows, error: null, count: rows.length };
      }
      if (orderCol) {
        const col = orderCol;
        rows = [...rows].sort((a, b) => {
          const av = a[col] as number | string;
          const bv = b[col] as number | string;
          return (av < bv ? -1 : av > bv ? 1 : 0) * (orderAsc ? 1 : -1);
        });
      }
      // range(from,to) must honor the offset (real PostgREST Range semantics):
      // backfillEmailsForContact's junction pass paginates via .range(offset,
      // offset+999) and breaks on a short page, so dropping the offset would
      // return the first page forever and loop endlessly on >pageSize rows.
      if (limitN !== null) rows = rows.slice(rangeFrom, rangeFrom + limitN);
      ops.push({ table, op, filters: [...filters] });
      return { data: rows, error: null, count: rows.length };
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double mirrors the untyped builder chain
    const builder: any = {
      select: () => builder,
      eq: (c: string, v: unknown) => { eqFilters.push([c, v]); filters.push([`eq:${c}`, v]); return builder; },
      in: (c: string, vs: unknown[]) => { inFilters.push([c, vs]); filters.push([`in:${c}`, vs]); return builder; },
      is: (c: string, v: unknown) => { isFilters.push([c, v]); filters.push([`is:${c}`, v]); return builder; },
      contains: (c: string, vs: unknown[]) => { containsFilters.push([c, vs]); filters.push([`contains:${c}`, vs]); return builder; },
      gt: (c: string, v: number) => { gtFilters.push([c, v]); filters.push([`gt:${c}`, v]); return builder; },
      gte: (c: string, v: unknown) => { filters.push([`gte:${c}`, v]); return builder; },
      order: (c: string, opts?: { ascending?: boolean }) => { orderCol = c; orderAsc = opts?.ascending ?? true; return builder; },
      limit: (n: number) => { limitN = n; return builder; },
      range: (fromIdx: number, toIdx: number) => { rangeFrom = fromIdx; limitN = toIdx - fromIdx + 1; return builder; },
      update: (values: Row, _opts?: { count?: string }) => { op = "update"; updateValues = values; return builder; },
      upsert: (rows: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
        op = "upsert";
        upsertRows = Array.isArray(rows) ? rows : [rows];
        upsertOpts = opts ?? {};
        return builder;
      },
      single: async () => {
        const res = execute();
        const row = (res.data as Row[])[0] ?? null;
        return row ? { data: row, error: null } : { data: null, error: { code: "PGRST116" } };
      },
      maybeSingle: async () => {
        const res = execute();
        return { data: (res.data as Row[])[0] ?? null, error: null };
      },
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
        try {
          resolve(execute());
        } catch (e) {
          if (reject) reject(e); else throw e;
        }
      },
    };
    return builder;
  }

  return {
    client: { from },
    tables,
    ops,
    opsFor: (table: string, op?: DbOp["op"]) =>
      ops.filter((o) => o.table === table && (op === undefined || o.op === op)),
  };
}
