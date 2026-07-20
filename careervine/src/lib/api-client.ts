/**
 * Typed client for CareerVine's own /api routes (CAR-158, F24).
 *
 * Pairs with `withApiHandler`'s TResponse generic: a route's success shape is
 * recovered with `InferApiResponse<typeof GET>` and passed here, so producer
 * and consumer cannot drift.
 *
 *   import type { InferApiResponse } from "@/lib/api-handler";
 *   import type { GET } from "@/app/api/gmail/follow-ups/awaiting-review/route";
 *   const { count } = await apiFetch<InferApiResponse<typeof GET>>(
 *     "/api/gmail/follow-ups/awaiting-review",
 *   );
 *
 * ── Why it discriminates on status ───────────────────────────────────────
 *
 * The wrapper can fail from eight places, and every one of them returns an
 * `ApiErrorBody` rather than the success shape. A client that types
 * `res.json()` as TResponse alone is MORE wrong than an untyped one: a 500
 * body would typecheck as a success and only blow up when a field is read.
 * So the non-2xx branch never returns — it throws `ApiRequestError` carrying
 * the curated message, status and code. That also collapses the four
 * different spellings of error extraction that grew up across ~40 call sites.
 *
 * ── Why there is a no-body variant ───────────────────────────────────────
 *
 * The single most common idiom in this codebase is status-only (`if (!res.ok)
 * throw`), where the body is never parsed. A wrapper that forced a JSON parse
 * would be worse than raw fetch at those sites, get bypassed, and leave a
 * fourth idiom behind. `apiSend` covers them.
 */

import type { ApiErrorBody } from "@/lib/api-handler";

/** A non-2xx response from one of our own API routes. */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    public status: number,
    /** Machine-readable code when the route supplied one (e.g. 'rate_limited'). */
    public code?: string,
    /** The parsed error body, when the response carried one. */
    public body?: ApiErrorBody,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/** True when the value is an ApiRequestError, for use in catch blocks. */
export function isApiRequestError(err: unknown): err is ApiRequestError {
  return err instanceof ApiRequestError;
}

const FALLBACK_MESSAGE = "Something went wrong. Please try again.";

/**
 * Turn a non-ok Response into an ApiRequestError, preferring the route's own
 * curated message. Per the CAR-149 convention those messages are already
 * user-safe (raw driver errors are logged server-side, never returned), so
 * they can surface in the UI directly. A body that is missing or unparseable
 * (an HTML error page from the edge, say) falls back to generic copy rather
 * than showing the user a parser error.
 */
async function toApiError(res: Response): Promise<ApiRequestError> {
  let body: ApiErrorBody | undefined;
  try {
    body = (await res.json()) as ApiErrorBody;
  } catch {
    body = undefined;
  }
  const message =
    typeof body?.error === "string" && body.error.trim() ? body.error : FALLBACK_MESSAGE;
  return new ApiRequestError(message, res.status, body?.code, body);
}

/**
 * Fetch one of our API routes and return its parsed success body as T.
 * Throws ApiRequestError on any non-2xx.
 *
 * `credentials: "same-origin"` is the default so the Supabase auth cookie
 * rides along, matching what the raw-fetch call sites relied on implicitly.
 */
export async function apiFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, { credentials: "same-origin", ...init });
  if (!res.ok) throw await toApiError(res);
  try {
    return (await res.json()) as T;
  } catch {
    // A 2xx whose body is empty or not JSON (a 204, or an edge/proxy response
    // that never reached the route). Bare res.json() would reject with a
    // SyntaxError, which callers catching ApiRequestError would miss entirely.
    // Mirrors the guard toApiError already applies to the failure path, so
    // everything thrown from this module is an ApiRequestError.
    throw new ApiRequestError(
      "The server returned an unreadable response. Please try again.",
      res.status,
      "unreadable_response",
    );
  }
}

/**
 * Fetch one of our API routes for effect, ignoring the response body.
 * Throws ApiRequestError on any non-2xx.
 *
 * Use for mutations whose result the caller does not read. This is the typed
 * replacement for the bare `if (!res.ok) throw new Error(...)` idiom, and it
 * gains the curated server message that idiom threw away.
 */
export async function apiSend(input: string, init?: RequestInit): Promise<void> {
  const res = await fetch(input, { credentials: "same-origin", ...init });
  if (!res.ok) throw await toApiError(res);
}

/** JSON-body request init, so call sites stop repeating the header literal. */
export function jsonBody(value: unknown, method = "POST"): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  };
}
