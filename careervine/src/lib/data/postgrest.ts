/**
 * Shared PostgREST scale utilities (CAR-146; retires audit findings F53/F29).
 *
 * Convention: every .in() filter over a caller-supplied id list goes through
 * chunked()/chunkList() (PostgREST filters ride the URL, which blows up past a
 * few hundred ids), and unbounded multi-row reads paginate via paginateAll()
 * (PostgREST caps a response at 1000 rows and truncates silently).
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
 * Run a query per bounded id chunk and concatenate the rows.
 *
 * ONLY safe when the query returns AT MOST ONE ROW PER ID — a keyed lookup like
 * contacts-by-id, where a 200-id chunk can never exceed 200 rows. It bounds the
 * .in() FILTER, not the RESPONSE (CAR-223): on a table that fans out (several
 * interactions, emails or past roles per contact) a single chunk can itself
 * blow past PostgREST's 1000-row cap and truncate silently. Use
 * chunkedPaginated() for those.
 */
export async function chunked<T>(ids: number[], fn: (chunk: number[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    out.push(...(await fn(ids.slice(i, i + 200))));
  }
  return out;
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
  const out: T[] = [];
  for (const chunk of chunkList(ids, chunkSize)) {
    out.push(...(await paginateAll<T>((from, to) => fetchPage(chunk, from, to), pageSize)));
  }
  return out;
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
