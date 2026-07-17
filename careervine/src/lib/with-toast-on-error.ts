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
 */
export async function withToastOnError(
  action: () => Promise<void>,
  toastError: (message: string) => void,
  message: string,
): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (err) {
    console.error(message, err);
    toastError(message);
    return false;
  }
}
