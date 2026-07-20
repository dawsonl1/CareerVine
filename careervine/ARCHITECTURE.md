# CareerVine — Architecture Guide

> **Purpose**: This document gives LLM coding agents (and human developers) a
> fast, accurate map of the codebase so they can make changes confidently.

---

## 1. What is CareerVine?

A professional networking CRM built with **Next.js 16 (App Router)** and
**Supabase** (Postgres + Auth). Users track contacts, meetings, interactions,
and action items. The UI follows **Material Design 3** guidelines.

---

## 2. Tech Stack

| Layer | Technology |
| --- | --- |
| Framework | Next.js 16 (App Router, Turbopack) |
| Language | TypeScript (strict) |
| Styling | Tailwind CSS v4 + M3 CSS custom properties |
| UI Components | Custom M3 components (no third-party component library) |
| Icons | Lucide React |
| Database | Supabase (Postgres with Row Level Security) |
| Auth | Supabase Auth (email/password) |
| Fonts | Geist Sans / Geist Mono (Google Fonts) |

---

## 3. Directory Structure

```text
careervine/
├── src/
│   ├── app/                        # Next.js App Router pages
│   │   ├── layout.tsx              # Root layout (AuthProvider, fonts, metadata)
│   │   ├── globals.css             # M3 design tokens, Tailwind theme
│   │   ├── page.tsx                # Dashboard (/, follow-up reminders, recent contacts)
│   │   ├── contacts/page.tsx       # Contacts CRUD + detail view with meetings/interactions/actions
│   │   ├── meetings/page.tsx       # Activity page (meetings + interactions unified timeline)
│   │   ├── action-items/page.tsx   # Action items CRUD with filters
│   │   ├── interactions/page.tsx   # Contact-scoped interactions (used as embedded component)
│   │   └── settings/page.tsx       # User profile + password change
│   │
│   ├── components/
│   │   ├── auth-provider.tsx       # React Context for auth state (useAuth hook)
│   │   ├── auth-form.tsx           # Sign in / sign up form
│   │   ├── navigation.tsx          # M3 top app bar + nav tabs
│   │   ├── sign-out-button.tsx     # Sign out button
│   │   └── ui/                     # Reusable M3 UI primitives
│   │       ├── button.tsx          # M3 Button (filled/tonal/outlined/text/danger)
│   │       ├── card.tsx            # M3 Card (filled/elevated/outlined)
│   │       ├── checkbox.tsx        # M3 Checkbox
│   │       ├── modal.tsx           # M3 Dialog with scrim
│   │       ├── select.tsx          # Custom dropdown select (portal-based)
│   │       ├── date-picker.tsx     # Calendar date picker
│   │       ├── time-picker.tsx     # Clock-face time picker (12h AM/PM)
│   │       ├── month-year-picker.tsx # Month + year picker (for graduation dates)
│   │       ├── contact-picker.tsx  # Searchable multi-select for contacts
│   │       ├── school-autocomplete.tsx # University name autocomplete
│   │       └── degree-autocomplete.tsx # Degree abbreviation autocomplete
│   │
│   └── lib/
│       ├── database.types.ts       # TypeScript types matching Supabase schema
│       ├── queries.ts              # Frozen re-export barrel over lib/data/ (CAR-146)
│       ├── data/                   # Domain query modules + db()/must() client seam
│       ├── types.ts                # Shared app-level TypeScript types
│       └── supabase/
│           ├── config.ts           # Env-based config (auto-switches local/prod)
│           ├── browser-client.ts   # Browser-side Supabase client
│           ├── server-client.ts    # Server-side Supabase client (SSR)
│           ├── admin.ts            # Admin client (service role key)
│           └── service-client.ts   # Service client variant
```

---

## 4. Database Schema (Supabase / Postgres)

### Core Tables

| Table | Purpose | Key Columns |
| --- | --- | --- |
| `users` | User profiles (extends auth.users) | `id` (UUID), `first_name`, `last_name`, `phone` |
| `contacts` | Professional network contacts | `user_id`, `name`, `industry`, `follow_up_frequency_days`, `contact_status` |
| `meetings` | Formal meetings | `user_id`, `meeting_date`, `meeting_type`, `notes`, `transcript` |
| `interactions` | Informal touchpoints (coffee, email, etc.) | `contact_id`, `interaction_date`, `interaction_type`, `summary` |
| `follow_up_action_items` | Tasks/reminders | `user_id`, `contact_id`, `meeting_id`, `title`, `description`, `due_at`, `is_completed` |

### Junction / Detail Tables

| Table | Purpose |
| --- | --- |
| `meeting_contacts` | Many-to-many: meetings ↔ contacts |
| `action_item_contacts` | Many-to-many: action items ↔ contacts |
| `contact_emails` | Multiple emails per contact |
| `contact_phones` | Multiple phones per contact (with type) |
| `contact_companies` | Employment history (with title, is_current) |
| `contact_schools` | Education history (with degree, field_of_study) |
| `contact_tags` | Many-to-many: contacts ↔ tags |
| `companies` | Company lookup table |
| `schools` | School lookup table |
| `tags` | User-defined tags |

### Attachment Tables (schema exists, not yet implemented)

| Table | Purpose |
| --- | --- |
| `attachments` | File metadata (url, filename, mime_type) |
| `contact_attachments` | Files linked to contacts |
| `meeting_attachments` | Files linked to meetings |
| `interaction_attachments` | Files linked to interactions |

---

## 5. Key Patterns

### Authentication Flow

1. `AuthProvider` wraps the entire app in `layout.tsx`
2. `useAuth()` hook provides `user`, `session`, `signIn`, `signUp`, `signOut`
3. All pages check `if (!user)` before rendering authenticated content
4. Supabase RLS ensures data isolation per user at the database level

### Data Fetching

- Queries live in domain modules under `src/lib/data/` (contacts, interactions,
  meetings, action-items, follow-ups, home, attachments, users); `src/lib/queries.ts`
  is a frozen compatibility barrel that re-exports them (CAR-146) — new queries go
  in the domain modules, not the barrel
- The Supabase client is resolved lazily via `db()` from `src/lib/data/client.ts`
  (browser singleton by default, injectable via `setDataClient()`); control-flow-bearing
  reads use the `must()` throw-on-error convention documented there
- Shared PostgREST scale utilities (`escapeIlike`, `chunkList`, `chunked`,
  `paginateAll`) live in `src/lib/data/postgrest.ts`
- Pages call queries in `useEffect` on mount
- Pattern: `useState` + `useEffect` + `loadData()` async function

### Server-only Boundary (CAR-158)

- Modules that read a secret from `process.env` carry `import "server-only"` so a
  client component importing one fails `next build` instead of shipping the
  credential read into the browser bundle. The fenced set is listed in
  `src/__tests__/server-only-fence.test.ts`, which also fails if a NEW
  secret-reading module under `src/lib` appears unfenced
- Two modules are deliberately exempt and the test records why:
  `supabase/config.ts` (holds the service-role read but is reached by browser
  client code and edge middleware; fenced instead by `getSupabaseEnv({server:true})`
  plus the CAR-151 import restriction) and `admin-notify.ts` (SendGrid, defunct)
- `server-only` throws outside React's server layer, so two non-Next runtimes
  need help: `vitest.config.ts` aliases it to its own `empty.js`, and the MCP
  server's start script passes `--conditions=react-server`. Note the alias is
  deliberate: setting `ssr.resolve.conditions: ['react-server']` also redirects
  `react-dom/client` to its RSC stub and breaks every React component test

### Typed API Responses (CAR-158)

- `withApiHandler` carries a `TResponse` generic inferred from the handler's
  return, so a route's success shape is recoverable by consumers:
  `export type Response = InferApiResponse<typeof GET>`
- Client code calls routes through `apiFetch<T>` / `apiSend` in
  `src/lib/api-client.ts`. Both discriminate on status and throw
  `ApiRequestError` carrying the route's curated message, so the error body can
  never be mistaken for the success shape
- A route's true wire type is `TResponse | ApiErrorBody`; typing only the happy
  path would make client code more wrong, not less

### Convention Guard

- `npm run check:conventions` (`scripts/check-conventions.mjs`, wired into CI)
  enforces four data-layer invariants that tsc and eslint cannot express: the
  `queries.ts` barrel freeze, no module-scope Supabase client under
  `src/lib/data|rules`, the rule-17 CAS readback shape, and growth of raw
  query-builder use in `src/mcp/lib/db.ts`
- Two escape hatches, both requiring a written reason: `// cas-checked: <why>`
  for an update+select chain that is not a compare-and-set, and
  `// error-tolerated: <why>` for a read where empty-on-error is correct

### Form Pattern

- Modal dialogs for create/edit (M3 dialog style)
- `useState` for each form field
- `handleSubmit` function handles both create and update
- `editingItem` state determines create vs. edit mode
- Scrim click dismisses modal (with unsaved-changes guard on some forms)

### Inline Edit Pattern (Action Items)

Action items can be edited inline on meeting cards and contact detail views:

- `cardEditActionId` state tracks which action is being edited
- When editing, the action row expands to show title, description, ContactPicker, DatePicker
- Save calls `updateActionItem` + `replaceContactsForActionItem`

### Styling

- M3 design tokens defined as CSS custom properties in `globals.css`
- Tailwind v4 `@theme` block maps CSS vars to Tailwind tokens
- Common classes extracted to `inputClasses` and `labelClasses` constants per page
- Components use M3 shape tokens (4px–28px rounded corners)
- Color: green primary (#2d6a30), white background, black on-surface

---

## 6. Page-by-Page Guide

### Dashboard (`/` — `src/app/page.tsx`)

- Quick-add contact form
- Recent contacts list
- Upcoming action items
- Follow-up reminders (contacts overdue based on `follow_up_frequency_days`)

### Contacts (`/contacts` — `src/app/contacts/page.tsx`)

- **Largest page** (~1400 lines) — full CRUD with expandable detail view
- Contact list with search/filter
- Expandable cards show: activity timeline (meetings + interactions), pending actions, completed actions
- Modal form for create/edit with: name, status (student/professional), company, school, emails, phones, tags, follow-up frequency, preferred contact method
- Inline action item editing
- Interaction create/edit modal
- Meeting detail modal with edit mode

### Activity (`/meetings` — `src/app/meetings/page.tsx`)

- Unified timeline of meetings AND interactions (sorted by date, newest first)
- Meeting cards show: type, date, attendees, notes, transcript, action items
- Interaction cards show: type, date, contact, summary
- "Add meeting" modal with: date, time, type, contacts, notes, transcript, action items
- "Add interaction" modal with: contact, date, type, summary
- Inline action item editing on meeting cards

### Action Items (`/action-items` — `src/app/action-items/page.tsx`)

- Pending and completed action items
- Create modal with: title, description, contacts, due date, meeting link
- Edit modal with same fields
- Toggle complete/incomplete
- Filter by contact

### Settings (`/settings` — `src/app/settings/page.tsx`)

- Edit profile: first name, last name, phone
- Change password (via Supabase Auth `updateUser`)

---

## 7. Queries Reference (`src/lib/data/*`, re-exported by the `src/lib/queries.ts` barrel)

### Contacts

- `getContacts(userId)` — all contacts with emails, phones, companies, schools, tags
- `createContact(contact)` / `updateContact(id, updates)` / `deleteContact(id)`
- `findOrCreateCompany(name)` / `findOrCreateSchool(name)`
- `addCompanyToContact()` / `removeCompaniesFromContact()`
- `addSchoolToContact()` / `removeSchoolsFromContact()`
- `addEmailToContact()` / `removeEmailsFromContact()`
- `addPhoneToContact()` / `removePhonesFromContact()`
- `addTagToContact()` / `removeTagFromContact()`

### Meetings

- `getMeetings(userId)` — all meetings with attendees
- `getMeetingsForContact(contactId)` — meetings for a specific contact
- `createMeeting()` / `updateMeeting()`
- `addContactsToMeeting()` / `replaceContactsForMeeting()`

### Interactions

- `getInteractions(contactId)` — interactions for one contact
- `getAllInteractions(userId)` — all interactions with contact names
- `createInteraction()` / `updateInteraction()` / `deleteInteraction()`

### Action Items

- `getActionItems(userId)` — pending items for user
- `getActionItemsForMeeting(meetingId)` — items linked to a meeting
- `getActionItemsForContact(contactId)` — pending items for a contact
- `getCompletedActionItems(userId)` / `getCompletedActionItemsForContact(contactId)`
- `createActionItem(item, contactIds)` / `updateActionItem()` / `deleteActionItem()`
- `replaceContactsForActionItem()`

### Tags

- `getTags(userId)` / `createTag()`

### User Profile

- `getUserProfile(userId)` / `updateUserProfile(userId, updates)`

### Follow-up Reminders

- `getHomeCoreData(userId).followUps` — contacts overdue for follow-up with days_overdue

---

## 8. Environment Variables

```env
# Local development (in .env.local)
NEXT_PUBLIC_SUPABASE_URL_LOCAL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY_LOCAL=<local-anon-key>
SUPABASE_SERVICE_ROLE_KEY_LOCAL=<local-service-key>

# Production (in Vercel project settings)
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<prod-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<prod-service-key>
```

The `config.ts` auto-switches based on `NODE_ENV`.

---

## 9. Known Gaps / Future Work

- **File attachments**: Full schema exists (`attachments`, `contact_attachments`, `meeting_attachments`, `interaction_attachments`) but zero UI implementation
- **Interactions page** (`/interactions`): Currently only works as an embedded component scoped to a single contact — not used as a standalone page
- **Search**: No global search across contacts/meetings/interactions
- **Offline support**: None — requires network connection
- **Testing**: No automated tests exist
