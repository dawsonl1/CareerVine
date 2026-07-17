# CAR-145 — Frontend shared infrastructure: typed ui-events, latest-request guard, ComposeEmailModal hardening

Retires audit findings **F18, F19, F23, F42** (+ the compose slice of **F21**). Straight A's / CAR-28. Blocked-by CAR-138 (CI gate) — **merged**, so we are clear.

**Do NOT touch `src/components/email/inbox/inbox-shell.tsx`** — its dispatch/formula conversions land in the InboxShell ticket (CAR-150). It stays exempt from the grep guard until then.

## Verified current state (line numbers confirmed against HEAD)

Event bus is untyped `window` CustomEvents with these names:
`careervine:email-sent`, `careervine:conversation-logged`, `careervine:onboarding-todo-changed`, `careervine:drafts-changed`, `careervine:unread-changed`.

Non-inbox files touching the bus (all to convert): `compose-email-modal.tsx`, `contact-emails-tab.tsx`, `compose-email-context.tsx`, `onboarding/onboarding-context.tsx`, `onboarding/extension-onboarding-modal.tsx`, `app/page.tsx` (listeners **+** a `careervine:home:` localStorage cache key at :87 — must stop matching the grep), `app/meetings/page.tsx`, `email/outreach/outreach-shell.tsx`, `app/action-items/page.tsx`, `app/contacts/[id]/page.tsx`, `conversation-modal/index.tsx`.

Canonical unread-delta formula (appears 4×; 2 live in inbox-shell, converted later): `!msg.is_read && msg.direction === "inbound" ? -1 : 0`.

`useToast` (`@/components/ui/toast`) supports `actions: [{label,onClick}]` (retry) and **throws without a provider** → existing compose test needs a toast mock. Compose modal is mounted inside `ToastProvider` in `layout.tsx`. Vitest is node-env; RTL tests opt in with `// @vitest-environment jsdom`.

## Slices

### 1. `src/lib/ui-events.ts` (F18) — NEW
- `UI_EVENTS` const map (name → literal). Per-event payload types: `EmailSentDetail = { onboardingIntro?: boolean } | undefined`; `UnreadChangedDetail = { delta: number } | { refetch: true } | undefined`; others `undefined`.
- `emitUiEvent(name, detail?)` (SSR-guarded, dispatches `CustomEvent`), `onUiEvent(name, handler): () => void` (returns unsubscribe, typed detail).
- `unreadDeltaFor(msg: { is_read: boolean; direction: string | null }): number` — the single formula.
- Keep event string values identical so raw dispatches in inbox-shell still interoperate during the CAR-150 gap.

### 2. `src/hooks/use-latest-request.ts` (F19) — NEW
- Returns a **stable** object (`useMemo []`) `{ begin(): token, isLatest(token): boolean }` backed by a `tokenRef`. Unmount effect bumps the token so late resolvers are dropped (also kills setState-after-unmount).

### 3. Convert all non-inbox dispatch/listen sites (F18)
- Swap every `window.dispatchEvent(new CustomEvent(...))` → `emitUiEvent(...)` and every add/removeEventListener pair → `onUiEvent(...)` cleanup. `onboarding-context` reads typed `detail.onboardingIntro`; `compose-email-context` reads typed `detail.delta`/`detail.refetch`.
- Rename the home cache key `careervine:home:${id}` → `careervine-home:${id}` (localStorage; orphaning old entries is a harmless one-time cache miss) so the grep guard is satisfied.

### 4. CI grep guard (F18)
- `scripts/check-ui-events.mjs`: fail if `careervine:` appears in `src/**` outside `src/lib/ui-events.ts`, its test, and `src/components/email/inbox/inbox-shell.tsx`. Helpful error message.
- Wire: `package.json` script `check:ui-events`; new `ci.yml` step in the `web` job after Lint.

### 5. F19 application sites
- Compose provenance effect (`compose-email-modal` ~:90): guard `setEmailMeta` behind `isLatest` (a bounce banner must never attach to a newer recipient).
- Compose contact-autocomplete (`searchContacts` ~:250): guard the suggestions setState.
- `contact-emails-tab.handleExpandEmail`: guard `setExpandedEmailContent`/loading behind a per-expand token (stale body must not fill a newer row).

### 6. F23 — keyed-remount ComposeEmailModal
- Add `composeSessionId` to `compose-email-context` (increment in `openCompose`, expose in value + default). Bumps on **every** open, covering the open-while-open case the reset effect handled.
- Split file: outer `ComposeEmailModal` = `useCompose()` → `if (!isOpen) return null; return <ComposeEmailModalBody key={composeSessionId} />`. Inner `ComposeEmailModalBody` holds all 33 useState + refs + effects + JSX, deriving **initial** state from context (no reset effect). `track("compose_opened")` + autofocus move into a mount effect (`[]`). Delete the ~:173 reset effect and the `if (!isOpen) return null` inside the body.

### 7. F42 — double-submit + ghost-draft
- `submittingRef = useRef(false)`; line one of `handleSendNow`/`handleScheduleSend` is `if (submittingRef.current) return;`, set `true` after validation, release in `finally` (retry after failure works; success unmounts the button anyway).
- Ghost-draft: in `saveDraft`, after the POST resolves, if `sentOrScheduledRef.current` is set, DELETE the just-created draft and **do not** record its id.

### 8. F21 (compose slice) — follow-up failure visibility
- `createFollowUpRecords`: check `res.ok`, throw on failure (drop the swallow-and-warn).
- `await` it at both send/schedule call sites inside a local try/catch; on failure `toastError("Email sent, but follow-ups could not be scheduled", { actions: [{ label: "Retry", onClick }] })` (no em dashes). The send already succeeded, so still dispatch `email-sent` and close.
- Add `useToast` to the body.

### 9. Tests (Vitest + RTL)
- `ui-events.test.ts`: `unreadDeltaFor` truth table; `onUiEvent`/`emitUiEvent` round-trip + unsubscribe contract.
- `use-latest-request.test.tsx`: harness issues two deferred requests, resolves out of order → only the latest commits; fails if `isLatest` is stubbed true.
- `compose-modal-reset.test.tsx`: open for B, draft, reopen for A (bump `composeSessionId`) → no leak of subject/schedule/AI banner (keyed remount).
- `compose-modal-send-guards.test.tsx`: double-invoke `Send` → one `/api/gmail/send` POST; autosave resolving post-send → DELETE issued for the ghost draft; forced 500 on `/api/email-follow-ups` → failure toast shown.
- Update `compose-followups.test.tsx`: add `vi.mock("@/components/ui/toast", ...)` and `composeSessionId` in the mock.

### 10. Gate + ship
- `npm run test`, `npx tsc --noEmit`, `npx eslint . --max-warnings 0`, `node scripts/check-ui-events.mjs`, `npx next build` — all green.
- Check docs page (`public/docs/index.html`) for drift (rule 34) — expected none (internal reliability); confirm.
- Commit, push, `gh pr create` with `(CAR-145)`.

### 11. Deep review + remediate
- Run `/deep-review-pr` on the PR. Fix **every** verified finding incl. nits, in this PR/ticket. Re-gate. Leave the branch merge-ready.
