import { describe, it, expect, vi } from "vitest";
import { withToastOnError } from "@/lib/with-toast-on-error";
import { ApiRequestError } from "@/lib/api-client";

/**
 * `preferServerMessageFor` (CAR-204).
 *
 * The default — caller copy wins, `ApiRequestError.message` is discarded — is
 * right almost everywhere, and these tests pin that it stays the default. The
 * exception it exists for: a route that refuses a write for a reason only it
 * knows. Cancelling a scheduled email the cron has already claimed answers
 * 409 "This email is already sending or was sent."; the generic copy replaced
 * that with "Please try again", which is advice that can never succeed on an
 * operation that will never succeed, while withholding the one fact the user
 * needs.
 *
 * Per-status rather than a blanket flag because the generic 401/500 bodies
 * ("Unauthorized", "An unexpected error occurred") are strictly worse than
 * caller copy — opting in wholesale would turn every expired-session toast into
 * a bare "Unauthorized".
 */

const CALLER_COPY = "Couldn't cancel that scheduled email. Please try again.";

function failWith(err: unknown) {
  return () => Promise.reject(err);
}

describe("withToastOnError", () => {
  it("returns true and toasts nothing on success", async () => {
    const toastError = vi.fn();
    await expect(withToastOnError(async () => {}, toastError, CALLER_COPY)).resolves.toBe(true);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("prefers the caller's copy by default, even for an ApiRequestError", async () => {
    const toastError = vi.fn();
    const err = new ApiRequestError("This email is already sending or was sent.", 409);

    await expect(withToastOnError(failWith(err), toastError, CALLER_COPY)).resolves.toBe(false);
    expect(toastError).toHaveBeenCalledWith(CALLER_COPY);
  });

  it("surfaces the route's message for an opted-in status", async () => {
    const toastError = vi.fn();
    const err = new ApiRequestError("This email is already sending or was sent.", 409);

    await withToastOnError(failWith(err), toastError, CALLER_COPY, {
      preferServerMessageFor: [409],
    });

    expect(toastError).toHaveBeenCalledWith("This email is already sending or was sent.");
  });

  it("keeps the caller's copy for a status that was NOT opted in", async () => {
    // The whole point of the per-status list: a 500 on the same call site must
    // not render "An unexpected error occurred" at the user.
    const toastError = vi.fn();
    const err = new ApiRequestError("An unexpected error occurred", 500);

    await withToastOnError(failWith(err), toastError, CALLER_COPY, {
      preferServerMessageFor: [409],
    });

    expect(toastError).toHaveBeenCalledWith(CALLER_COPY);
  });

  it("keeps the caller's copy for a network failure, which carries no status", async () => {
    // A TypeError is an Error, so a bare `err.message` would put Chrome's
    // "Failed to fetch" in the UI. isApiRequestError is what excludes it.
    const toastError = vi.fn();

    await withToastOnError(failWith(new TypeError("Failed to fetch")), toastError, CALLER_COPY, {
      preferServerMessageFor: [409],
    });

    expect(toastError).toHaveBeenCalledWith(CALLER_COPY);
  });
});
