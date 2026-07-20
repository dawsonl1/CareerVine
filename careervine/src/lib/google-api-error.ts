/**
 * Narrowing helpers for errors thrown by the Google API clients (@googleapis/*).
 *
 * Those clients reject with a GaxiosError, and call sites branch on details
 * buried in it: the HTTP status (410 means an expired sync token, 401 a dead
 * grant), a rate-limit `reason`, or the OAuth `invalid_grant` marker. None of
 * that is visible on `unknown`, and the old idiom — `catch (err: any)` then
 * reach through `err?.response?.data?.error?.errors?.[0]?.reason` — bought
 * those few reads at the cost of every other guarantee in the block.
 *
 * The accessors below walk the error structurally instead. `prop()` performs
 * the one sound narrowing (typeof check, then index) and everything else is
 * built from it, so no shape is ever ASSERTED that has not been checked. That
 * matters here specifically because the shapes differ across gaxios majors and
 * between transport failures and HTTP failures: an assumed interface would be
 * a lie that typechecks, which is worse than the `any` it replaced.
 *
 * Modelled on the same idea as `errorStatus` in lib/deepgram.ts.
 */

/** Read a property off an unknown value, or undefined if it is not an object. */
function prop(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

/** Read index 0 off an unknown value, or undefined if it is not an array. */
function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : undefined;
}

/** True for an Error that carries any of the fields a Google rejection uses. */
export function isGoogleApiError(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;
  return "code" in err || "status" in err || "response" in err || "errors" in err;
}

/**
 * HTTP status of a Google API rejection, or undefined when there is none.
 *
 * All three locations are read deliberately: gaxios has moved the status
 * between `code` and `status` across majors and also exposes it on
 * `response.status`. `code` holds a STRING for transport-level failures
 * ("ENOTFOUND", "ECONNRESET"), which must not be mistaken for a status, so
 * only an integer is ever returned — a caller comparing against 410 cannot
 * match a DNS failure.
 */
export function googleApiStatus(err: unknown): number | undefined {
  const status = prop(err, "status");
  if (typeof status === "number") return status;

  const code = prop(err, "code");
  if (typeof code === "number") return code;
  if (typeof code === "string") {
    const parsed = Number(code);
    if (Number.isInteger(parsed)) return parsed;
  }

  const responseStatus = prop(prop(err, "response"), "status");
  return typeof responseStatus === "number" ? responseStatus : undefined;
}

/**
 * The `reason` string Google attaches to a failure ("rateLimitExceeded",
 * "userRateLimitExceeded", ...). Present either at the top level or nested
 * under the response body, depending on which layer produced the error.
 */
export function googleApiReason(err: unknown): string | undefined {
  const direct = prop(first(prop(err, "errors")), "reason");
  if (typeof direct === "string") return direct;

  const nested = prop(
    first(prop(prop(prop(prop(err, "response"), "data"), "error"), "errors")),
    "reason",
  );
  return typeof nested === "string" ? nested : undefined;
}

/**
 * The OAuth-level error code from the response body, e.g. "invalid_grant"
 * when a refresh token has been revoked or expired. Distinct from the HTTP
 * status: a revoked grant is reported in the body, not always as a 401.
 */
export function googleOAuthErrorCode(err: unknown): string | undefined {
  const error = prop(prop(prop(err, "response"), "data"), "error");
  return typeof error === "string" ? error : undefined;
}
