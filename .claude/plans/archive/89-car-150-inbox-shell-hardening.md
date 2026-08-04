# CAR-150 — InboxShell hardening & decomposition

**Branch:** `dawson/car-150-impl-review-89e008` · **Blocked-by:** CAR-145 (merged to `main`, commit `7f31f7b`) · **Retires:** F22 + inbox legs of F18/F19/F21.

`careervine/src/components/email/inbox/inbox-shell.tsx` (1,567 lines, 32 useState, zero behavioral tests) is the repo's likeliest place for an agent to silently break an invariant. This ticket **exclusively owns** `inbox-shell.tsx` and its new inbox child components. CAR-145 already shipped the infra we build on: `@/lib/ui-events` (`emitUiEvent`/`onUiEvent`/`unreadDeltaFor`), `@/hooks/use-latest-request`, `@/components/ui/toast` (`useToast`), and the `scripts/check-ui-events.mjs` CI guard (which currently exempts this file).

## Reference implementations already in the tree
- **ui-events + latest-request + toast in a mutating email view:** `src/components/contacts/contact-emails-tab.tsx` (uses `expandReq.begin()/isLatest()`, `emitUiEvent(UI_EVENTS.unreadChanged, {delta})`, `unreadDeltaFor`, `useToast().error`).
- **Behavioral component test harness:** `src/__tests__/outreach-shell.test.tsx` (mocks `navigation`, `auth-provider`, `compose-email-context`, `ui/toast`; stubs `global.fetch`; drives real shell).
- **Rollback-or-toast template:** `src/hooks/use-deferred-action.ts`.

## Implementation order (each phase ends green; tests precede the structural move)

### Phase A — Safety-net tests first (against current behavior)
1. `src/__tests__/gmail-helpers.test.ts` — add a `buildThreads` block: groups by `thread_id` (falls back to `gmail_message_id` when null); messages sorted oldest→newest; threads sorted newest-first by `latestDate`; `subject` from first message with `(no subject)` fallback; `contactId` from first message; single-message thread keyed correctly. (Zero coverage today; feeds inbox, sent, contact views.)
2. `src/__tests__/inbox-shell.test.tsx` (new) — render the **real** `InboxShell` with mocked `useAuth`/`useCompose`/`useToast`/`useRouter`/`navigation`/`follow-up-modal`/`gmail-sync-client`/`analytics`, stub `fetch`. Assert current-correct behaviors that must survive the refactor:
   - expand a single-message thread → body renders (from `/api/gmail/emails/:id`).
   - trash from inbox → row leaves the list **and** a `careervine:unread-changed` event fires (spy on `window.dispatchEvent` / listen via `onUiEvent`).
   - tab switch (Inbox→Trash→Inbox) → expansion collapses.

### Phase B — Internal hardening inside `inbox-shell.tsx`
3. **Expansion reducer.** New `src/components/email/inbox/use-thread-expansion.ts`: `useReducer` over `{threadId, emailId, content}` exposing `expandedThreadId/expandedEmailId/expandedEmailContent` + `collapseAll()`, `expandThread(id)`, `expandEmail(id)`, `collapseEmail()`, `setContent(c)`. Semantics — `collapseAll`: all→null; `expandThread`: set thread, clear email+content; `expandEmail`: set email, clear content (keep thread); `collapseEmail`: clear email+content (keep thread); `setContent`: set content only. Replace the three `useState`s and **every** hand-reset site (lines ~329–334, 359, 376, 387–402, 414–465, 1062–1064) with these actions. `loadingEmailContent` stays a local `useState` (pure spinner). Exit: no `setExpandedThreadId/EmailId/EmailContent` setters remain outside the hook; exactly one `collapseAll` path; `switchTab` calls `collapseAll()`.
4. **ui-events conversion (F18 inbox leg).** Convert the two listen sites (`careervine:email-sent`, `careervine:drafts-changed`) to `onUiEvent(UI_EVENTS.…, …)` and the dispatch sites (read-mark ×2, trash, hide, move) to `emitUiEvent(UI_EVENTS.unreadChanged, …)` with `unreadDeltaFor(msg)` for the delta. **Fix the two live drift bugs:** `handleRestoreEmail` and `handleUnhideEmail` currently emit nothing; restoring/unhiding an **unread inbound** message must emit `{ delta: +1 }` (`-unreadDeltaFor(msg)`) so the nav badge re-counts it.
5. **Latest-request guard (F19 inbox leg).** Add `useLatestRequest()`; in `handleExpandEmail` claim `const token = expandReq.begin()` right after `expandEmail(id)`, and gate `setContent(...)` + `setLoadingEmailContent(false)` behind `expandReq.isLatest(token)` (both the fetched-body path and the error/finally). Stale slower fetch for a since-collapsed/-switched message can no longer overwrite content or clear the wrong spinner.
6. **Mutation rollback + toast (F21 inbox leg).** Add `const { error: toastError } = useToast()`. For the six optimistic mutations — trash, restore, hide, unhide, move, deleteDraft — capture the removed object (already done), then `try { const res = await fetch(...); if (!res.ok) throw new Error(); } catch { <reverse the exact optimistic change: undo the list add + re-insert the removed item + reverse any badge delta>; toastError(<message>); }`. buildThreads re-sorts, so re-inserting at the front is display-equivalent.
7. **Sort fix.** Line ~1516: `fu.email_follow_up_messages.sort(...)` mutates state in render → `[...fu.email_follow_up_messages].sort(...)`. (Line ~1493 already `.filter().sort()`, safe.)
8. **Tighten CI guard.** Drop `src/components/email/inbox/inbox-shell.tsx` from `EXEMPT` in `scripts/check-ui-events.mjs`; update the stale "exempt until CAR-150" notes there and in `src/lib/ui-events.ts`. Exit: `rg "careervine:"` clean outside `ui-events.ts` + tests.

### Phase C — New-behavior tests
9. Extend `inbox-shell.test.tsx`: restore-from-trash of an unread inbound → `{ delta: +1 }` fires; a mutation whose `fetch` rejects (or returns `!ok`) → the item is restored to its list **and** an error toast is raised (assert via the mocked `useToast().error` spy); a tab-switch-collapse assertion that would fail if `collapseAll()` were removed from `switchTab`.

### Phase D — Tab extraction (structural; tests are the safety net)
10. Split the render closures into sibling components under `src/components/email/inbox/`, each receiving **only the state it owns** (no cross-tab state):
    - `thread-list-tab.tsx` — `ThreadListTab` (the ~265-line `renderThreadList` + `renderExpandedContent`/`renderEmailActions`/`renderMsgRowActions`), props: `threads`, `tabCtx`, expansion state + actions, `contactMap`, `gmailLabels`, `followUpsByThread`, `calendarByThread`, the dropdown/menu/tooltip state, and the email-action callbacks.
    - `drafts-tab.tsx` — `DraftsTab` (props: `drafts`, `openDraft`, `deleteDraft`, `formatDate`).
    - `scheduled-tab.tsx` — `ScheduledTab` (props: `scheduledEmails`, `followUps`, `contactMap`, `onCancel`, `onRetry`, `onOpenFollowUp`, formatters).
    - `followups-tab.tsx` — `FollowUpsTab` (props: `followUps`, `onCancel`, `onOpenFollowUp`, formatters).
    Coordinator (`inbox-shell.tsx`) keeps data-loading, filters, sidebar, top bar, and modal; target **< ~600 lines**. Re-run the full suite after each extraction.

### Phase E — Verify (all must be green)
`npm run test` · `npx tsc --noEmit` · `npx eslint . --max-warnings 0` · `node scripts/check-ui-events.mjs` · `npx next build`. Docs page (`public/docs/index.html`) is high-level product narrative and documents none of these controls at the button/badge level → no rule-34 update. Open PR with `(CAR-150)` title, then run `/deep-review-pr` and fix every verified finding (incl. nits) in this same PR/ticket.

## Exit criteria (from the ticket)
- No direct `setExpandedEmailContent/EmailId` outside the reducer; exactly one `collapseAll` path; removing it from tab-switch fails a test.
- `inbox-shell.tsx` < ~600 lines; no child imports another tab's state; no in-place sort on state.
- `rg "careervine:"` clean outside `ui-events.ts` + tests.
- All behavioral tests green; `npm run test` + `next build` green.
