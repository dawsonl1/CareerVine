import { useMemo, useReducer } from "react";
import type { EmailMessageFull } from "@/lib/types";

/**
 * The InboxShell's thread/message expansion invariant (CAR-150 / F22).
 *
 * Three fields move together and were hand-reset in ~9 places across the shell,
 * the kind of scattered invariant an edit silently breaks (a stale
 * `expandedEmailContent` left behind, a spinner that never clears). This reducer
 * is the single owner of that transition: the shell reads the three values and
 * drives them only through the exposed actions, never with raw setters.
 *
 * Semantics:
 * - `collapseAll`   — nothing expanded (tab switch, closing an open thread).
 * - `expandThread`  — open a thread; no message body selected yet.
 * - `expandEmail`   — select a message within the open thread; clear stale body.
 * - `collapseEmail` — deselect the message but keep the thread open.
 * - `setContent`    — attach the fetched body to the currently-selected message.
 *
 * `loadingEmailContent` stays a plain `useState` in the shell: it is a pure
 * spinner flag, not part of the expansion identity.
 */

export interface ThreadExpansionState {
  expandedThreadId: string | null;
  expandedEmailId: string | null;
  expandedEmailContent: EmailMessageFull | null;
}

type ThreadExpansionAction =
  | { type: "collapseAll" }
  | { type: "expandThread"; threadId: string }
  | { type: "expandEmail"; emailId: string }
  | { type: "collapseEmail" }
  | { type: "setContent"; content: EmailMessageFull | null };

const INITIAL: ThreadExpansionState = {
  expandedThreadId: null,
  expandedEmailId: null,
  expandedEmailContent: null,
};

function reducer(
  state: ThreadExpansionState,
  action: ThreadExpansionAction,
): ThreadExpansionState {
  switch (action.type) {
    case "collapseAll":
      return INITIAL;
    case "expandThread":
      return {
        expandedThreadId: action.threadId,
        expandedEmailId: null,
        expandedEmailContent: null,
      };
    case "expandEmail":
      return {
        ...state,
        expandedEmailId: action.emailId,
        expandedEmailContent: null,
      };
    case "collapseEmail":
      return { ...state, expandedEmailId: null, expandedEmailContent: null };
    case "setContent":
      return { ...state, expandedEmailContent: action.content };
    default:
      return state;
  }
}

export function useThreadExpansion() {
  const [state, dispatch] = useReducer(reducer, INITIAL);

  // `dispatch` is stable, so these actions are safe in effect/callback deps.
  const actions = useMemo(
    () => ({
      collapseAll: () => dispatch({ type: "collapseAll" }),
      expandThread: (threadId: string) =>
        dispatch({ type: "expandThread", threadId }),
      expandEmail: (emailId: string) =>
        dispatch({ type: "expandEmail", emailId }),
      collapseEmail: () => dispatch({ type: "collapseEmail" }),
      setContent: (content: EmailMessageFull | null) =>
        dispatch({ type: "setContent", content }),
    }),
    [],
  );

  return { ...state, ...actions };
}
