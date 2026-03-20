# Undo on Destructive Actions

## Problem

Deleting a contact or completing/deleting an action item is permanent and immediate. The current UX uses native `window.confirm()` dialogs, which users click through habitually. There's no way to recover from an accidental deletion.

## Solution

Replace confirmation dialogs with a **deferred-deletion pattern**: perform the action optimistically in the UI, show a toast with an "Undo" button, and delay the actual database operation by 5 seconds. If the user clicks Undo, the item reappears instantly. If they don't, the deletion commits silently.

This pattern feels faster (the item disappears immediately) and safer (undo is one click away).

## Scope

### In scope
- **Contact deletion** (3 trigger points: contact detail page, contact info header, contact edit modal)
- **Action item deletion** (2 trigger points: action items page, contact actions tab)
- **Action item completion** (2 trigger points: action items page, contact actions tab)

### Out of scope
- Soft-delete / trash feature (database-level recoverability)
- Undo for edits or other mutations
- Batch undo

---

## Architecture

### Core concept: `useDeferredAction` hook

A reusable hook that encapsulates the deferred-deletion pattern:

```typescript
function useDeferredAction<T>({
  action: (item: T) => Promise<void>,  // the actual destructive DB call
  undoMessage: string | ((item: T) => string),
  delayMs?: number,                     // default 5000
  onUndo?: (item: T) => void,          // callback to restore UI state
  onCommit?: (item: T) => void,        // callback after action commits
  onError?: (item: T, error: Error) => void,
})
```

Returns:

```typescript
{
  execute: (item: T) => void,   // start deferred action + show toast
  cancel: (item: T) => void,    // programmatic undo (e.g., unmount cleanup)
  pending: Set<T>,              // items currently pending deletion
}
```

**Flow:**
1. Caller invokes `execute(item)`
2. Hook stores item in pending set, shows toast with Undo button
3. `setTimeout` schedules the actual `action(item)` call after `delayMs`
4. If user clicks Undo → clear timeout, remove from pending, call `onUndo(item)`, dismiss toast
5. If timer expires → call `action(item)`, call `onCommit(item)` on success
6. On component unmount → all pending actions commit immediately (no data loss)

### Why a hook and not middleware?

The app uses simple `useState` with full reloads after mutations. A hook keeps the pattern local and composable without requiring architectural changes to state management. Each component manages its own optimistic removal and restoration.

---

## Detailed Changes

### 1. Enhance toast system to support undo pattern

**File:** `careervine/src/components/ui/toast.tsx`

The toast system already supports action buttons and configurable durations. Changes needed:

- Add a **progress bar** variant that visually counts down the 5-second window. This gives the user a clear sense of urgency and time remaining. Render as a thin bar at the bottom of the toast that shrinks over the duration using a CSS animation.
- Add an `onDismiss` callback so the hook knows when the toast disappears (to commit the action if dismissed manually).
- Ensure calling `dismiss(toastId)` from the hook works cleanly when Undo is clicked.

No new dependencies needed.

### 2. Create `useDeferredAction` hook

**New file:** `careervine/src/hooks/use-deferred-action.ts`

```typescript
import { useRef, useCallback, useEffect } from "react";
import { useToast } from "@/components/ui/toast";

interface DeferredActionOptions<T> {
  action: (item: T) => Promise<void>;
  undoMessage: string | ((item: T) => string);
  delayMs?: number;
  onUndo?: (item: T) => void;
  onCommit?: (item: T) => void;
  onError?: (item: T, error: Error) => void;
  toastVariant?: "success" | "info" | "warning";
}

export function useDeferredAction<T extends { id: number }>({
  action,
  undoMessage,
  delayMs = 5000,
  onUndo,
  onCommit,
  onError,
  toastVariant = "success",
}: DeferredActionOptions<T>) {
  const pendingRef = useRef<Map<number, { item: T; timerId: NodeJS.Timeout }>>(new Map());
  const { toast, dismiss } = useToast();

  // On unmount, commit all pending actions immediately
  useEffect(() => {
    return () => {
      for (const [, { item }] of pendingRef.current) {
        action(item).catch(() => {}); // best-effort commit
      }
      pendingRef.current.clear();
    };
  }, []);

  const execute = useCallback((item: T) => {
    const message = typeof undoMessage === "function" ? undoMessage(item) : undoMessage;

    const timerId = setTimeout(async () => {
      pendingRef.current.delete(item.id);
      try {
        await action(item);
        onCommit?.(item);
      } catch (err) {
        onError?.(item, err as Error);
      }
    }, delayMs);

    pendingRef.current.set(item.id, { item, timerId });

    const toastId = toast(message, {
      variant: toastVariant,
      duration: delayMs,
      showProgress: true,
      actions: [
        {
          label: "Undo",
          onClick: () => {
            clearTimeout(timerId);
            pendingRef.current.delete(item.id);
            dismiss(toastId);
            onUndo?.(item);
          },
        },
      ],
    });
  }, [action, undoMessage, delayMs, onUndo, onCommit, onError, toast, dismiss]);

  return { execute };
}
```

### 3. Update contact deletion (3 locations)

**General pattern for all three:**

Before (current):
```typescript
const handleDelete = async () => {
  if (!confirm("Are you sure you want to delete this contact?")) return;
  await deleteContact(contact.id);
  success("Contact deleted");
  // redirect or callback
};
```

After:
```typescript
const { execute: deferDelete } = useDeferredAction({
  action: async (contact) => {
    await deleteContact(contact.id);
  },
  undoMessage: (contact) => `${contact.name} deleted`,
  onUndo: (contact) => {
    // Re-add contact to local state (no DB call needed since delete hasn't happened)
    setContacts(prev => [...prev, contact].sort(/* by name */));
    // If we navigated away, navigate back
  },
  onCommit: () => {
    // Optional: reload to sync state
  },
  onError: (_, err) => {
    error("Failed to delete contact");
  },
});

const handleDelete = () => {
  // Optimistically remove from UI
  setContacts(prev => prev.filter(c => c.id !== contact.id));
  deferDelete(contact);
  // Navigate away if on detail page
};
```

#### 3a. Contact detail page (`app/contacts/[id]/page.tsx`, lines 205-214)

- Remove `window.confirm()` call
- Optimistically redirect to `/contacts` immediately
- On undo: `router.push(`/contacts/${contact.id}`)` to navigate back
- Edge case: if user navigates to another contact's page during the 5s window, the pending deletion still commits (handled by unmount cleanup)

#### 3b. Contact info header (`components/contacts/contact-info-header.tsx`, lines 242-250)

- Remove `window.confirm()` call
- Call `onContactDelete()` callback immediately (parent handles optimistic UI removal)
- On undo: need a new `onContactRestore` callback prop, or lift the deferred logic to the parent

**Decision:** Lift the `useDeferredAction` to the parent page component that owns the contact state. The header's delete button just calls `onDelete(contact)` which the parent handles via the hook. This avoids duplicating the hook across child components.

#### 3c. Contact edit modal (`components/contacts/contact-edit-modal.tsx`, lines 232-240)

- Same as 3b: delegate to parent via callback. The modal calls `onContactDelete()`, parent handles deferral.

### 4. Update action item deletion (2 locations)

#### 4a. Action items page (`app/action-items/page.tsx`, lines 108-117)

Before:
```typescript
const removeItem = async (id: number) => {
  if (!confirm("Permanently delete this action item?")) return;
  await deleteActionItem(id);
  await loadActionItems();
  success("Action item deleted");
};
```

After:
```typescript
const { execute: deferDeleteItem } = useDeferredAction({
  action: async (item) => await deleteActionItem(item.id),
  undoMessage: (item) => `"${item.title}" deleted`,
  onUndo: (item) => {
    // Restore to appropriate list based on completion status
    if (item.is_completed) {
      setCompletedItems(prev => [...prev, item]);
    } else {
      setActionItems(prev => [...prev, item]);
    }
  },
  onError: () => error("Failed to delete action item"),
});

const removeItem = (item: ActionItem) => {
  // Optimistically remove from UI
  setActionItems(prev => prev.filter(a => a.id !== item.id));
  setCompletedItems(prev => prev.filter(a => a.id !== item.id));
  // Close detail modal if showing this item
  if (selectedItem?.id === item.id) setSelectedItem(null);
  deferDeleteItem(item);
};
```

Note: `removeItem` currently takes just an `id`. Change signature to accept the full item object so the hook can restore it on undo.

#### 4b. Contact actions tab (`components/contacts/contact-actions-tab.tsx`, lines 185-198)

Same pattern. Remove `window.confirm()`, optimistically remove from local state, defer the actual `deleteActionItem()` call.

### 5. Update action item completion (2 locations)

Completion is slightly different because it's not a deletion — the item moves from active to completed. But it should still be undoable.

#### 5a. Action items page (`app/action-items/page.tsx`, lines 119-140)

Before:
```typescript
const markDone = async (item: ActionItem) => {
  await updateActionItem(item.id, { is_completed: true, completed_at: new Date().toISOString() });
  await loadActionItems();
  // show toast with optional "Log conversation" action
};
```

After:
```typescript
const { execute: deferComplete } = useDeferredAction({
  action: async (item) => {
    await updateActionItem(item.id, {
      is_completed: true,
      completed_at: new Date().toISOString(),
    });
  },
  undoMessage: (item) => `"${item.title}" completed`,
  onUndo: (item) => {
    // Move back from completed to active
    setCompletedItems(prev => prev.filter(a => a.id !== item.id));
    setActionItems(prev => [...prev, item]);
  },
  onCommit: () => {
    // Reload to get accurate server state
    loadActionItems();
  },
  onError: () => error("Failed to complete action item"),
});

const markDone = (item: ActionItem) => {
  // Optimistically move to completed list
  setActionItems(prev => prev.filter(a => a.id !== item.id));
  setCompletedItems(prev => [{ ...item, is_completed: true, completed_at: new Date().toISOString() }, ...prev]);
  deferComplete(item);
};
```

**Important:** The existing "Log conversation" action button on completion toasts is valuable. The undo toast should include BOTH "Undo" and "Log conversation" buttons when completing an item that has a contact assigned.

#### 5b. Contact actions tab (`components/contacts/contact-actions-tab.tsx`, lines 175-178)

Same pattern — optimistic move between lists, deferred DB update, undo restores.

---

## Edge Cases

### Navigation during pending deletion
- **Contact deletion + redirect:** If user deletes a contact from the detail page, they're redirected to `/contacts`. If they undo, navigate back to `/contacts/{id}`. The contact data was never deleted from DB so the page loads fine.
- **Page unmount:** The hook's cleanup effect commits all pending actions immediately. This prevents data loss if the user navigates away.

### Multiple pending deletions
- Each deletion gets its own timer and toast. The `pendingRef` map (keyed by item ID) tracks them independently.
- Deleting the same item twice is a no-op (it's already in pending).

### Rapid delete-undo-delete
- Second delete while first is pending: clear first timer, start new one. Map key collision handles this naturally.

### Action item completion undo + "Log conversation"
- If the user clicks "Log conversation" during the 5s window, the completion should commit immediately (cancel the timer, run the action, then open the log modal). Don't let them log a conversation for an action that might get undone.

### Contact deletion cascades
- Contact deletion cascades to emails, phones, companies, interactions, etc. This is fine because the deletion is deferred — if undone, nothing was deleted. If committed, cascades happen atomically in the DB.
- Action items survive (contact_id → NULL). On undo, the action items never lost their contact_id since the delete never happened.

### Offline / network failure
- If the deferred action fails when it finally fires, show an error toast: "Failed to delete [name]. The item has been restored." Then call `onUndo` to put it back in the UI.

---

## Toast UI Design

```
┌──────────────────────────────────────┐
│  ✓  "Jane Smith" deleted      [Undo] │
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░  │ ← progress bar shrinks over 5s
└──────────────────────────────────────┘
```

For action item completion with a contact:
```
┌──────────────────────────────────────────────────┐
│  ✓  "Send resume" completed   [Log]  [Undo]      │
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░  │
└──────────────────────────────────────────────────┘
```

- Progress bar uses `transition: width` with `linear` easing, duration matches `delayMs`
- Bar color matches toast variant (green for success, blue for info)
- Bar starts full width and shrinks to 0

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/hooks/use-deferred-action.ts` | **Create** | Core hook for deferred actions with undo |
| `src/components/ui/toast.tsx` | **Modify** | Add progress bar, `onDismiss`, `showProgress` prop |
| `src/app/contacts/[id]/page.tsx` | **Modify** | Replace confirm dialog with deferred delete |
| `src/components/contacts/contact-info-header.tsx` | **Modify** | Remove confirm, delegate to parent |
| `src/components/contacts/contact-edit-modal.tsx` | **Modify** | Remove confirm, delegate to parent |
| `src/app/action-items/page.tsx` | **Modify** | Replace confirm with deferred delete/complete |
| `src/components/contacts/contact-actions-tab.tsx` | **Modify** | Replace confirm with deferred delete/complete |

**Tests:**

| File | Action | Description |
|------|--------|-------------|
| `src/hooks/__tests__/use-deferred-action.test.ts` | **Create** | Unit tests for the hook (timer, undo, unmount cleanup) |
| Update existing component tests | **Modify** | Update to reflect removed confirm dialogs |

---

## Implementation Order

1. **Toast enhancements** — Add progress bar and `onDismiss` support
2. **`useDeferredAction` hook** — Build and test in isolation
3. **Action item deletion** — Simpler scope, good proving ground
4. **Action item completion** — Adds the "move between lists" pattern
5. **Contact deletion** — Most complex due to navigation and cascade implications
6. **Testing** — Hook unit tests + update component tests

---

## What This Doesn't Do

- **No soft-delete or trash:** Items are still hard-deleted after the 5s window. This is a UX improvement, not a data recovery feature. A trash/archive feature would be a separate initiative.
- **No server-side undo:** The undo is purely client-side timing. If the browser crashes during the 5s window, the item survives (delete never fired).
- **No undo for edits:** Only deletions and completions. Edits are lower-risk and would require snapshotting previous state.
