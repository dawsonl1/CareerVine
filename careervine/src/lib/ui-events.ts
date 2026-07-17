/**
 * Typed cross-view coherence event bus (CAR-145 / F18).
 *
 * The app keeps independent views (home, inbox, outreach, contact pages, the
 * nav badge) in sync by broadcasting `window` CustomEvents. This module is the
 * single source of truth for those event names and their payload shapes: every
 * dispatch goes through `emitUiEvent` and every subscription through
 * `onUiEvent`, so a typo in an event name or a wrong payload field is a compile
 * error instead of a silent no-op.
 *
 * A CI guard (`scripts/check-ui-events.mjs`) forbids the raw `careervine:`
 * string literal anywhere in `src` outside this file, its test, and
 * `inbox-shell.tsx` (exempt until the InboxShell ticket converts it). The event
 * string VALUES must stay stable so raw dispatches still interoperate with
 * typed subscribers during that gap.
 */

export const UI_EVENTS = {
  /** An email was sent or scheduled from the composer. */
  emailSent: "careervine:email-sent",
  /** A conversation/meeting was logged via the unified capture modal. */
  conversationLogged: "careervine:conversation-logged",
  /** The onboarding to-do was created, completed, or deleted. */
  onboardingTodoChanged: "careervine:onboarding-todo-changed",
  /** A Gmail draft was created, updated, or deleted. */
  draftsChanged: "careervine:drafts-changed",
  /** The unread / awaiting-review count changed (optimistic delta or refetch). */
  unreadChanged: "careervine:unread-changed",
} as const;

export type UiEventName = (typeof UI_EVENTS)[keyof typeof UI_EVENTS];

/** Marks the guided-onboarding templated intro so the finale only fires on it. */
export type EmailSentDetail = { onboardingIntro?: boolean };

/**
 * `delta` = optimistic adjustment (trust it, skip the auto-refetch);
 * `refetch` = re-pull the authoritative count now; neither = delayed refetch.
 * Kept as independent optional flags to match how listeners read them.
 */
export type UnreadChangedDetail = { delta?: number; refetch?: boolean };

/** Payload shape per event; `undefined` means the event carries no detail. */
export interface UiEventDetailMap {
  "careervine:email-sent": EmailSentDetail | undefined;
  "careervine:conversation-logged": undefined;
  "careervine:onboarding-todo-changed": undefined;
  "careervine:drafts-changed": undefined;
  "careervine:unread-changed": UnreadChangedDetail | undefined;
}

/** Dispatch a typed UI event. No-op during SSR (there is no `window`). */
export function emitUiEvent<K extends UiEventName>(
  name: K,
  detail?: UiEventDetailMap[K],
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    detail === undefined
      ? new CustomEvent(name)
      : new CustomEvent(name, { detail }),
  );
}

/**
 * Subscribe to a typed UI event. Returns an unsubscribe function, so callers
 * can `return onUiEvent(...)` straight out of a `useEffect`.
 */
export function onUiEvent<K extends UiEventName>(
  name: K,
  handler: (detail: UiEventDetailMap[K]) => void,
): () => void {
  const listener = (event: Event) =>
    handler((event as CustomEvent<UiEventDetailMap[K]>).detail);
  window.addEventListener(name, listener);
  return () => window.removeEventListener(name, listener);
}

/**
 * The unread-badge delta for a message being marked read, trashed, or hidden.
 * Only unread INBOUND mail contributes to the unread count, so removing/reading
 * such a message decrements by one; everything else is a no-op. This is the
 * single definition of a formula that was duplicated across the inbox and
 * contact views (CAR-145 / F18).
 */
export function unreadDeltaFor(message: {
  is_read: boolean;
  direction: string | null;
}): number {
  return !message.is_read && message.direction === "inbound" ? -1 : 0;
}
