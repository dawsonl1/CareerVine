"use client";

import { useCallback, type KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * Escape closes an open in-DOM dropdown, not the dialog around it (CAR-205).
 *
 * ANY child that opens and closes owns Escape while it is open. Portalling is not
 * what makes the key ambiguous — having an open list inside a dialog is. Without a
 * handler, Escape over an open dropdown closes the dialog underneath it and leaves
 * the dropdown behind, because the dialog's own handler is a document listener that
 * fires regardless of where the key was pressed.
 *
 * The same rule `usePortalDropdown` and `select.tsx` implement, in the cheaper
 * form that a NON-portalled list can use. Those two need a document listener in
 * the capture phase because their panels are portalled out of the component's
 * own subtree, so a React handler on the wrapper never sees the keypress. These
 * lists are plain DOM children of the wrapper, and they only open from focus
 * inside it, so the event already passes through on its way up and a wrapper
 * `onKeyDown` is enough — no document listener, no `activeElement` heuristic.
 *
 * `stopPropagation` on a React synthetic event calls it on the underlying native
 * event, and React's listeners are attached at the root container rather than at
 * `document`, so stopping there really does prevent `modal.tsx`'s document-level
 * Escape handler from running. That is asserted rather than assumed, in
 * `careervine/src/__tests__/picker-escape.test.tsx`.
 *
 * Gated on `open` so a closed dropdown never swallows the dialog's own Escape.
 *
 * This form moves no focus, and does not need to for the wrappers on it today: the
 * key only reaches a wrapper `onKeyDown` when focus is already inside that wrapper,
 * and the trigger or input it sits on survives the close. A caller whose panel holds
 * focusable controls a user can land on should hand focus back to its trigger when
 * it closes, the way `usePortalDropdown` does — focus stranded on `<body>` disarms
 * the enclosing dialog's trap, which is a keydown handler *on* the surface.
 *
 * @example
 * const onKeyDown = useDropdownEscape(open, setOpen);
 * return <div ref={ref} className="relative" onKeyDown={onKeyDown}>…</div>;
 */
export function useDropdownEscape(open: boolean, close: (open: false) => void) {
  return useCallback(
    (e: ReactKeyboardEvent) => {
      if (e.key !== "Escape" || !open) return;
      e.stopPropagation();
      close(false);
    },
    [open, close],
  );
}
