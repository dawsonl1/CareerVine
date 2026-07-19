import { describe, it, expect, vi, afterEach } from "vitest";
import { withToastOnError } from "@/lib/with-toast-on-error";

/**
 * CAR-154 / F21: the helper that replaced the bare empty catches on interactive
 * mutation handlers. Success is silent; a throw toasts the message and reports
 * failure so callers can gate follow-up UI on the write landing.
 */
describe("withToastOnError", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns true and never toasts when the action succeeds", async () => {
    const toastError = vi.fn();
    const ran = vi.fn();
    const ok = await withToastOnError(async () => { ran(); }, toastError, "should not show");
    expect(ok).toBe(true);
    expect(ran).toHaveBeenCalledOnce();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("returns false and toasts the exact message when the action throws", async () => {
    const toastError = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ok = await withToastOnError(
      async () => { throw new Error("boom"); },
      toastError,
      "Couldn't do the thing. Please try again.",
    );
    expect(ok).toBe(false);
    expect(toastError).toHaveBeenCalledExactlyOnceWith("Couldn't do the thing. Please try again.");
  });
});
