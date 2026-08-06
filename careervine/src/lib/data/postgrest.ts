/**
 * Shared PostgREST scale utilities (CAR-146; retires audit findings F53/F29).
 *
 * Convention: every .in() filter over a caller-supplied id list goes through
 * chunked()/chunkList() (PostgREST filters ride the URL, which blows up past a
 * few hundred ids), and unbounded multi-row reads paginate via paginateAll()
 * (PostgREST caps a response at 1000 rows and truncates silently).
 *
 * Chunk reads run CONCURRENTLY under a module-wide ceiling (CAR-231). They used to
 * walk their chunks one at a time, which made every caller serial in
 * ceil(ids.length / chunkSize): /companies measured serial depth 19 and 4.2s on a
 * 2,005-contact account, because getContactStages' 8 legs were each walking an
 * 11-chunk staircase. See MAX_INFLIGHT_CHUNK_READS below for why the ceiling is
 * global rather than per call, and for the invariant that keeps it deadlock-free.
 */

/**
 * Escape %, _ and \ so user data can't act as ilike wildcards.
 *
 * Deliberately does NOT handle `*`, which PostgREST also treats as a wildcard
 * (it rewrites `*` to `%` in like/ilike patterns). That rewrite is a blind
 * substitution, so escaping it here would produce `\%` — a literal-percent
 * match, not a literal asterisk. PostgREST cannot express a literal `*` in a
 * pattern at all, so callers doing equality-style matching must treat the
 * ilike as a narrowing only and verify the match in JS (see
 * findOrCreateSchool in ./contacts).
 */
export function escapeIlike(s: string): string {
  return s.replace(/([\\%_])/g, "\\$1");
}

/** Split a list into bounded chunks for .in() filters (PostgREST selects are GETs). */
export function chunkList<T>(items: T[], size = 100): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Ceiling on chunk reads in flight across the WHOLE module, not per call (CAR-231).
 *
 * A per-call limit is the wrong bound here. getContactStages runs 8 chunked legs
 * simultaneously, so a per-call limit of N yields a peak of 8N — and the peak is the
 * only number Supabase cares about. One module-level gate means this file can state
 * the cap once and have it hold however many callers are in flight.
 *
 * Deadlock safety rests on one invariant: a task holding a slot never asks for a
 * second one. chunked() holds a slot for a single request; chunkedPaginated() holds
 * one for its chunk's whole page walk (pages must be sequential to know when to
 * stop). Neither nests, so there is no cycle. Do not call a gated function from
 * inside a gated callback.
 *
 * THE CAP MUST CLEAR THE WIDEST LEGITIMATE FAN-OUT, or the gate turns work that was
 * already parallel into a queue and ADDS depth — the opposite of the point. The
 * widest is getCompanyDetail's second wave: ten independent legs, each spanning one
 * or more chunks. An initial value of 8 throttled it and pushed two legs into a
 * third wave, which outreach-request-shape.test.ts caught. 24 clears that wave while
 * still bounding the case this exists for: getContactStages' 8 legs over ~11 chunks
 * each on a 2,005-contact account is 88 requests that would otherwise all be in
 * flight at once.
 */
const MAX_INFLIGHT_CHUNK_READS = 24;

let inFlight = 0;
const waiting: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (inFlight < MAX_INFLIGHT_CHUNK_READS) {
    inFlight++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  inFlight++;
}

function release(): void {
  inFlight--;
  waiting.shift()?.();
}

/**
 * Run `worker` over `items` with at most MAX_INFLIGHT_CHUNK_READS in flight globally,
 * preserving INPUT ORDER in the result.
 *
 * Order matters: callers concatenate chunk results and downstream consumers assume the
 * concatenation matches the id order they passed in. Results are therefore written into
 * a pre-sized array by index, never pushed on completion — the naive push-on-complete
 * version returns rows in whatever order the network happened to settle, which is a
 * silent data-ordering bug rather than a crash.
 */
async function mapWithConcurrency<In, Out>(
  items: In[],
  worker: (item: In) => Promise<Out>,
): Promise<Out[]> {
  const results: Out[] = new Array(items.length);
  let next = 0;

  const runner = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await acquire();
      try {
        results[i] = await worker(items[i]);
      } finally {
        release();
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(MAX_INFLIGHT_CHUNK_READS, items.length) }, runner),
  );
  return results;
}

/**
 * Run a query per bounded id chunk and concatenate the rows, in input order.
 *
 * ONLY safe when the query returns AT MOST ONE ROW PER ID — a keyed lookup like
 * contacts-by-id, where a 200-id chunk can never exceed 200 rows. It bounds the
 * .in() FILTER, not the RESPONSE (CAR-223): on a table that fans out (several
 * interactions, emails or past roles per contact) a single chunk can itself
 * blow past PostgREST's 1000-row cap and truncate silently. Use
 * chunkedPaginated() for those.
 */
export async function chunked<T>(ids: number[], fn: (chunk: number[]) => Promise<T[]>): Promise<T[]> {
  const pages = await mapWithConcurrency(chunkList(ids, 200), (chunk) => fn(chunk));
  return pages.flat();
}

/**
 * chunked() for tables that fan out: bounds the .in() filter AND pages through
 * the response, so neither the URL nor the 1000-row cap can silently drop rows
 * (CAR-223).
 *
 * Same contract as paginateAll — the query MUST carry a stable .order(), since
 * range pagination over an unspecified order can duplicate or drop rows at page
 * boundaries. The callback receives the range to apply; ignoring it would loop
 * forever, so `from`/`to` are required parameters rather than optional ones.
 */
export async function chunkedPaginated<T, Id = number>(
  ids: Id[],
  fetchPage: (chunk: Id[], from: number, to: number) => Promise<T[] | null>,
  opts: { chunkSize?: number; pageSize?: number } = {},
): Promise<T[]> {
  const { chunkSize = 200, pageSize = 1000 } = opts;
  // One gate slot per CHUNK, held for that chunk's whole page walk, rather than one
  // per page request. Pages within a chunk are inherently sequential (a short page is
  // the only stop signal), so releasing between them would just hand the slot away and
  // immediately queue for it again.
  const pages = await mapWithConcurrency(chunkList(ids, chunkSize), (chunk) =>
    paginateAll<T>((from, to) => fetchPage(chunk, from, to), pageSize),
  );
  return pages.flat();
}

/**
 * Fetch every row of a query by walking .range() windows until a short page.
 * The query MUST carry a stable .order() — range pagination over an
 * unspecified order can duplicate or drop rows at page boundaries.
 * A null page (some test mocks resolve `data: null`) counts as empty.
 */
export async function paginateAll<T>(
  fetchPage: (from: number, to: number) => Promise<T[] | null>,
  pageSize = 1000,
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const rows = (await fetchPage(from, from + pageSize - 1)) ?? [];
    all.push(...rows);
    if (rows.length < pageSize) return all;
  }
}
