# CAR-154 — Client mutation failure contract: rollback-or-toast everywhere, honest load-failure states, no-empty lint

Wave 4 · T17 · retires finding F21. Blockers **CAR-145** (ui-events + latest-request + `withToastOnError`-adjacent infra) and **CAR-150** (InboxShell) are both **Done and merged** into this worktree's base (PRs #109, #124 confirmed as ancestors; `ui-events.ts`, `use-latest-request.ts`, `use-deferred-action.ts` all present).

## Goal

1. Burn down every bare `catch {}` on interactive mutation handlers to a toast (or rollback-or-toast), via a small shared `withToastOnError` helper.
2. Annotate the genuinely best-effort / enrichment catches so they no longer read as silent swallows.
3. Give every primary loader an honest, retryable **load-failed** state, distinct from **load-empty**.
4. Turn on eslint `no-empty` so a future bare `catch {}` fails the CI lint gate.

## Findings from exploration

**16 bare `catch {}` sites** (exact list, `rg 'catch \{\}' careervine/src`). Classified:

Bucket A — interactive mutation handlers → **toast on failure**:
- `app/meetings/page.tsx:381` delete interaction
- `app/meetings/page.tsx:578` restore action item
- `app/meetings/page.tsx:582` complete action item
- `app/meetings/page.tsx:586` delete action item
- `app/contacts/page.tsx:958` create tag
- `components/contacts/contact-edit-modal.tsx:492` create tag
- `components/contacts/contact-info-header.tsx:641` create tag
- `components/contacts/contact-timeline-tab.tsx:51` delete interaction
- `components/availability-picker.tsx:456` save-as-default (also missing a `res.ok` check → add one)

Bucket B — best-effort enrichment / post-mutation refresh → **explanatory comment** (an ESLint `no-empty` block that contains a comment is *not* reported, so no `eslint-disable` pragma is needed and the site stops matching `rg 'catch \{\}'`):
- `app/meetings/page.tsx:135` calendar RSVP enrichment inside `loadMeetings`
- `app/meetings/page.tsx:156` per-meeting actions/attachments/segments enrichment
- `app/meetings/page.tsx:187` `reloadMeetingActions` post-mutation refresh
- `components/contacts/contact-actions-tab.tsx:84` `reloadActions` refresh
- `components/contacts/contact-emails-tab.tsx:164` `loadFollowUpsForThread` enrichment
- `components/availability-picker.tsx:153` priority-contact detection
- `components/availability-picker.tsx:170` availability-profile load (popover)

There are **no genuine analytics/telemetry** bare `catch {}` among the 16 (the analytics catches in `src/lib/analytics/server.ts` already carry comments and are multi-line). So the ticket's "annotated telemetry site" exception applies to zero sites here; `rg 'catch \{\}' careervine/src` ends up **empty**, which satisfies the exit criterion (only annotated sites remain, of which there are none) with `no-empty` green.

**Primary loaders — load-failed vs load-empty audit:**
- `app/page.tsx` `loadCoreData` (~:200) swallows the error `// silent` and sets `dataLoaded=true` → a failed first load renders the new-user / getting-started empty state.
- `app/calendar/page.tsx` `loadData` (~:194) has **no catch** on its `Promise.all` → a load failure is an unhandled rejection and renders the "No events" empty card.
- `app/contacts/page.tsx` `loadContacts` (~:134) logs and clears the spinner but sets no error → renders "Your network starts here" empty state.
- `app/meetings/page.tsx` `loadMeetings` (~:162) logs only → renders "No activity yet" empty state.
- **Inbox:** `components/email/inbox/use-inbox-data.ts` `loadInbox` (~:47) still only `console.error`s and returns no error state, so on failure the shell renders **"No emails synced yet."** — the exact anti-pattern the ticket names. CAR-150 did **not** land this. See "Scope note" below.

**Canonical patterns to reuse:**
- `components/email/outreach/outreach-shell.tsx` — `load()` sets a boolean `error`, and an `ErrorState({ onRetry })` renders "We could not load your outreach" / "Please try again in a moment." / `Retry`. I'll factor this into a shared `LoadErrorState`.
- RTL: `outreach-shell.test.tsx` (mock fetch + contexts, assert rendered UI) and `inbox-shell.test.tsx` (`mutationOk:false` forces a failed mutation → `toast.error` asserted).

## Changes

### New: `src/lib/with-toast-on-error.ts`
```ts
export async function withToastOnError(
  action: () => Promise<void>,
  toastError: (message: string) => void,
  message: string,
): Promise<boolean> // true on success, false on failure (console.error + toast)
```

### New: `src/components/ui/load-error-state.tsx`
Presentational, matches the outreach markup: `message` prop + `onRetry`, renders the message, "Please try again in a moment.", and a `Retry` button (variant outline).

### `eslint.config.mjs`
Add `{ rules: { "no-empty": ["error", { allowEmptyCatch: false }] } }`. CI already runs `npx eslint . --max-warnings 0`, so this becomes a gate automatically — no ci.yml change.

### Bucket A edits (toast)
Wrap each handler with `withToastOnError` (adding `useToast` to `contact-timeline-tab.tsx` and `availability-picker.tsx`, which lack it). Copy, no em dashes (rule 35): `"Couldn't <verb> ... Please try again."`

### Bucket B edits (comment annotations)
Replace each `catch {}` with `catch { /* one-line reason */ }`.

### Loader error states (dashboard, calendar, contacts, meetings, + inbox)
Each gets a boolean load-error flag, set true in the loader's catch and reset false at the loader's start; the page renders `<LoadErrorState message onRetry={retry} />` **only when the load failed AND there's nothing already on screen** (so a background-refresh failure over cached/streamed data doesn't blow away a working view). Messages: dashboard "We could not load your dashboard", calendar "We could not load your calendar", contacts "We could not load your contacts", meetings "We could not load your activity", inbox "We could not load your inbox". Retry re-invokes the loader(s).

### Tests (`src/__tests__/`)
- `with-toast-on-error.test.ts` — success path (no toast), failure path (toast + false).
- `meetings-page.test.tsx` — restore action item with `updateActionItem` rejecting → `toast.error` called; plus loader failure → `LoadErrorState` + Retry.
- `calendar-page.test.tsx` — loader fetch/query rejects → `LoadErrorState` + Retry, and Retry re-fetches.
- `contacts-page.test.tsx` — `getContactsStreamed` rejects → `LoadErrorState` + Retry.
- `home-page.test.tsx` — `getHomeCoreData` rejects (no cache) → `LoadErrorState`; and a successful empty load still shows the getting-started state (guards against false positives).
- `inbox-shell.test.tsx` — extend: `success:false` inbox payload → `LoadErrorState`, and the existing "No emails synced yet." empty-success cases stay green.

## Exit-criteria mapping
- `rg 'catch \{\}' careervine/src` → empty; `npx eslint . --max-warnings 0` green with `no-empty` active.
- Component tests: forced meetings-restore failure toasts; dashboard/calendar/contacts (and meetings, inbox) render a retryable error state on loader failure.
- `npm run test` + `next build` green.

## Scope note (flag for Dawson)
The ticket says "Inbox's loadInbox error state landed in CAR-150 — verify it." It did **not**: `use-inbox-data.ts` still swallows the error and the shell falls through to "No emails synced yet." on failure. Since the ticket cites that copy as the anti-pattern F21 exists to kill, and CAR-150 is already merged (no parallel-worktree conflict), I'm completing it here (small additive change to `use-inbox-data.ts` + `inbox-shell.tsx`) rather than leaving F21 half-done. Called out in the PR.
