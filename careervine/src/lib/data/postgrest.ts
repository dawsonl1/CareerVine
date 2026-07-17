/**
 * Shared PostgREST scale utilities (CAR-146; retires audit findings F53/F29).
 *
 * Convention: every .in() filter over a caller-supplied id list goes through
 * chunked()/chunkList() (PostgREST filters ride the URL, which blows up past a
 * few hundred ids), and unbounded multi-row reads paginate via paginateAll()
 * (PostgREST caps a response at 1000 rows and truncates silently).
 */

/** Escape %, _ and \ so user data can't act as ilike wildcards. */
export function escapeIlike(s: string): string {
  return s.replace(/([\\%_])/g, "\\$1");
}

/** Split a list into bounded chunks for .in() filters (PostgREST selects are GETs). */
export function chunkList<T>(items: T[], size = 100): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Run a query per bounded id chunk and concatenate the rows. */
export async function chunked<T>(ids: number[], fn: (chunk: number[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    out.push(...(await fn(ids.slice(i, i + 200))));
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
