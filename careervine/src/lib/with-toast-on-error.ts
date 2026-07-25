import { isApiRequestError } from "@/lib/api-client";

/**
 * Runs an async mutation and surfaces a toast when it throws, instead of the
 * bare empty catch that used to swallow interactive-handler failures silently
 * (CAR-154, finding F21). Returns true on success and false on failure, so a
 * caller can gate follow-up UI (close a menu, clear a field) on the write
 * actually landing.
 *
 * The `toastError` argument is the ToastProvider's `error` function
 * (`const { error: toastError } = useToast()`); passing it in keeps this a
 * plain helper usable from any handler without a hook wrapper.
 *
 * ── Why `message` wins by default, and when it should not ────────────────
 *
 * The caller's copy names the user's problem ("Couldn't cancel that scheduled
 * email"); the route's names the server's ("Follow-up sequence not found").
 * The former is better UI at most sites, which is why it is the default and
 * why `ApiRequestError.message` is otherwise discarded.
 *
 * But some routes refuse a write for a reason only they know, and then the
 * default is actively harmful: cancelling a scheduled email the cron has
 * already claimed answers 409 "This email is already sending or was sent.",
 * and the generic copy replaces that with "Please try again" — advice that can
 * never succeed, on an operation that will never succeed, while withholding
 * the one fact the user needs (CAR-204).
 *
 * `preferServerMessageFor` opts a call site into the route's own message for
 * specific statuses. It is per-status rather than a blanket flag because the
 * generic 401/500 bodies ("Unauthorized", "An unexpected error occurred") are
 * strictly worse than caller copy, so opting in wholesale would regress every
 * expired-session toast into a bare "Unauthorized".
 */
export async function withToastOnError(
  action: () => Promise<void>,
  toastError: (message: string) => void,
  message: string,
  options?: {
    /** Statuses whose curated server message should be shown instead of `message`. */
    preferServerMessageFor?: readonly number[];
  },
): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (err) {
    const preferred =
      options?.preferServerMessageFor &&
      isApiRequestError(err) &&
      options.preferServerMessageFor.includes(err.status)
        ? err.message
        : message;
    console.error(message, err);
    toastError(preferred);
    return false;
  }
}
