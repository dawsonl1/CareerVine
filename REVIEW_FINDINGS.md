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
- [ ] **#9** Non-atomic delete-then-insert in replaceContacts helpers — wrap in transaction or use RPC
- [x] **#10** `access_token!` assertion crashes if refresh token revoked — try/catch with connection cleanup and user-facing error
- [ ] **#11** Token refresh race condition between Gmail and Calendar clients
- [x] **#12** Malformed email Date header crashes batch sync — safe parse with null fallback

## Correctness (Priority 3)

- [x] **#13** `updated_at` set on table without that column — removed
- [x] **#14** Missing error checks on insert/update results — added
- [x] **#15** `getContactById` has no `user_id` filter — added optional userId param, call site passes user.id
- [ ] **#16** Calendar events created without timezone — pass timezone explicitly
- [ ] **#17** `loadingEmails` permanently false in contact-emails-tab — wire up properly
- [x] **#18** `createSupabaseBrowserClient()` called every render in auth-provider — stabilized with useState initializer
- [ ] **#19** Contacts page no auth loading check — flash of empty state before auth resolves
- [ ] **#20** Dashboard links go to /contacts instead of /contacts/{id}
- [x] **#21** Duplicate import branches doing same thing — collapsed

## Efficiency (Priority 4)

- [ ] **#22** N+1 queries in experience/education/tag import loops
- [ ] **#23** No retry/backoff for Gmail API rate limits during sync
- [ ] **#24** `getAllInteractions` two-query pattern could be one join
- [ ] **#25** Duplicated OAuth2 client + token refresh logic in gmail.ts/calendar.ts

## Nits

- [x] **#26** Debug console.log in parse-profile — removed with #3 fix
- [x] **#27** Unused `userId` params in import helpers — removed from addExperienceToContact, addEducationToContact
- [ ] **#28** server-client.ts unnecessarily requires service role key
- [ ] **#29** database.types.ts: companies/schools Insert requires id
- [ ] **#30** contact-info-header onContactUpdate passes stale data
- [x] **#31** contacts/[id] dynamic import of already-imported module — added getContacts to static import
- [ ] **#32** No user-visible error on dashboard quick-add failure
- [x] **#33** Unnecessary removeEmails/removePhones on new contacts — removed from create flow
- [ ] **#34** Tag dropdown no outside-click handler
- [ ] **#35** Search suggestion dropdown no outside-click handler
- [x] **#36** select("*") over-fetches sensitive token columns in gmail/calendar — narrowed to needed columns
- [ ] **#37** buildThreads recreated every render in inbox
- [ ] **#38** Missing loadData in useEffect dependency arrays
- [ ] **#39** getContacts over-fetches for list views
- [ ] **#40** getConnection fragile column selection
- [ ] **#41** Various type inconsistencies in database.types.ts
