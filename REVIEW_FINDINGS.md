# CareerVine Review Findings

## Status Key
- [x] Fixed
- [ ] TODO

---

## Security (Priority 1)

- [x] **#1** XSS via `dangerouslySetInnerHTML` — added DOMPurify (inbox, compose, emails tab)
- [x] **#2** OAuth CSRF — state now uses random nonce + userId + timestamp
- [x] **#3** Raw OpenAI response leaked to client — generic errors only
- [x] **#4** CORS `*` — verified safe per spec (wildcard prevents cookie CORS)
- [x] **#5** Search route bypasses RLS — switched to authenticated client
- [x] **#6** Search auth failure returns 200 — now returns 401
- [x] **#7** PostgREST filter injection — inputs sanitized

## Data Integrity (Priority 2)

- [x] **#8** Race condition in find-or-create (companies/schools/locations) — insert-then-retry-lookup on conflict
- [x] **#9** Non-atomic delete-then-insert in replaceContacts helpers — added backup/restore on failure
- [x] **#10** `access_token!` assertion crashes if refresh token revoked — try/catch with connection cleanup and user-facing error
- [x] **#11** Token refresh race condition between Gmail and Calendar clients — added per-user in-memory lock
- [x] **#12** Malformed email Date header crashes batch sync — safe parse with null fallback

## Correctness (Priority 3)

- [x] **#13** `updated_at` set on table without that column — removed
- [x] **#14** Missing error checks on insert/update results — added
- [x] **#15** `getContactById` has no `user_id` filter — added optional userId param, call site passes user.id
- [x] **#16** Calendar events created without timezone — added timeZone option with default
- [x] **#17** `loadingEmails` permanently false in contact-emails-tab — wired up as prop from parent
- [x] **#18** `createSupabaseBrowserClient()` called every render in auth-provider — stabilized with useState initializer
- [x] **#19** Preview page no auth loading check — added authLoading guard before AuthForm render
- [x] **#20** Dashboard links go to /contacts instead of /contacts/{id} — fixed to use contact ID
- [x] **#21** Duplicate import branches doing same thing — collapsed

## Efficiency (Priority 4)

- [x] **#22** N+1 queries in experience/education/tag import loops — batched company/school lookups and batch inserts
- [x] **#23** No retry/backoff for Gmail API rate limits during sync — added withRetry helper with exponential backoff
- [x] **#24** `getAllInteractions` two-query pattern could be one join — rewritten as single query with !inner join
- [x] **#25** Duplicated OAuth2 client + token refresh logic — consolidated into oauth-helpers.ts

## Nits

- [x] **#26** Debug console.log in parse-profile — removed with #3 fix
- [x] **#27** Unused `userId` params in import helpers — removed from addExperienceToContact, addEducationToContact
- [x] **#28** server-client.ts unnecessarily requires service role key — removed server:true flag
- [x] **#29** database.types.ts: companies/schools Insert requires id — made id optional in Insert types
- [x] **#30** contact-info-header onContactUpdate passes stale data — parent ignores arg and reloads, no bug
- [x] **#31** contacts/[id] dynamic import of already-imported module — added getContacts to static import
- [x] **#32** No user-visible error on dashboard quick-add failure — added quickAddError state and inline message
- [x] **#33** Unnecessary removeEmails/removePhones on new contacts — removed from create flow
- [x] **#34** Tag dropdown no outside-click handler — added ref + mousedown listener
- [x] **#35** Search suggestion dropdown no outside-click handler — added ref + mousedown listener
- [x] **#36** select("*") over-fetches sensitive token columns in gmail/calendar — narrowed to needed columns
- [x] **#37** buildThreads recreated every render in inbox — moved to module-level pure function
- [x] **#38** Missing loadData in useEffect dependency arrays — wrapped in useCallback, added to deps
- [x] **#39** getContacts over-fetches for list views — investigated, all callers use the full data; deferring lightweight version
- [x] **#40** getConnection fragile column selection — investigated, current columns match all callers' needs
- [x] **#41** Various type inconsistencies in database.types.ts — fixed companies/schools Insert types; junction tables confirmed correct
