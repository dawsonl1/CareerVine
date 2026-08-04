# CAR-73 — Dismiss individual getting-started checklist items

## Problem

`GettingStartedList` (`careervine/src/components/home/unified-action-list.tsx:227`) renders a
hardcoded checklist to brand-new accounts inside the "Up Next" empty state. The rows are
stateless navigation shortcuts — there is no per-item state, so a user can't remove one they
don't care about. They only vanish implicitly once the account has real activity.

## Decisions (with Dawson)

- **Persistence: account-level DB column**, not localStorage — survives across devices.
- **UX: per-item dismiss (X)**, hover-revealed, stops the row's navigation click. No "dismiss all".

## Stable item IDs

`getting-started-bundle`, `getting-started-company`, `getting-started-calendar`,
`getting-started-extension`, `getting-started-log`. These are the persisted dismissal keys.

## Changes

1. **Migration** `supabase/migrations/20260711150000_dismissed_getting_started.sql`
   - `ALTER TABLE users ADD COLUMN dismissed_getting_started text[] NOT NULL DEFAULT '{}';`
   - `GRANT UPDATE (dismissed_getting_started) ON users TO authenticated;` (users_update_own
     already scopes rows to auth.uid()).
   - COMMENT documenting it as the CAR-73 dismissed-checklist-id set.
   - No backfill needed — default `{}` is correct for every existing account.

2. **Types** `careervine/src/lib/database.types.ts`
   - Add `dismissed_getting_started: string[]` to `users.Row`.
   - Add to the Insert omit-list + optional `dismissed_getting_started?: string[]` (Update is
     Partial<Insert>, so the user-writable path is covered).

3. **Query helper** `careervine/src/lib/queries.ts`
   - `getDismissedGettingStarted(userId): Promise<string[]>` — select the column, default `[]`.
   - `setDismissedGettingStarted(userId, ids: string[]): Promise<void>` — write the full array
     (client owns the set; avoids array_append RPC and read-modify-write races).

4. **Home page** `careervine/src/app/page.tsx`
   - Load the dismissed set into state when `user` is present.
   - Handler `dismissGettingStarted(id)`: optimistic add to state, persist via
     `setDismissedGettingStarted`; on error revert + toast.
   - Thread `dismissedGettingStarted` + `onDismissGettingStarted` into `<UnifiedActionList>`.

5. **List component** `careervine/src/components/home/unified-action-list.tsx`
   - `UnifiedActionListProps`: add `dismissedGettingStarted: string[]` +
     `onDismissGettingStarted: (id: string) => void`; thread to `GettingStartedList`.
   - `GettingStartedList`: filter out dismissed IDs; add a hover-revealed X button per row that
     calls `onDismiss(id)` and `stopPropagation()`s the row's navigate click.
   - Empty state: when the filtered checklist is empty and there's no onboarding row, render a
     minimal muted "You're all set" line instead of an empty bordered box.

6. **Tests** — extend `unified-action-list-onboarding.test.tsx` (or a new file): dismissed IDs
   are filtered out; clicking X fires `onDismissGettingStarted` with the right id and does NOT
   navigate.

7. **README** — note the dismissible getting-started checklist from a product angle.

## Verification

- `npm run test` + `npm run build` from `careervine/`.
- Migration validated by rolled-back apply against production (rule 32) before merge; applied
  with `supabase db push` after merge (rule 27).
