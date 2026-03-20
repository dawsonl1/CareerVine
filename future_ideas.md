# CareerVine - Future Ideas

## Done

### ~~Zod Validation on All API Routes~~
Done. Every API route now uses Zod schemas via `withApiHandler()`. Schemas defined in `src/lib/api-schemas.ts`. Validates input shape, types, and constraints. Returns structured 400 errors on validation failure. Numeric query params use `z.coerce.number()` instead of manual `parseInt()`.

### ~~Centralized API Error Handler~~
Done. `withApiHandler()` in `src/lib/api-handler.ts` handles auth, Zod validation, CORS, error logging, and structured responses for all 40+ routes. Supports `extensionAuth`, `cors`, and `authOptional` options. Reduced ~1,700 lines of duplicated try/catch boilerplate.

### ~~Conversation-Centric Redesign~~
Done. The app now centers on conversations and action items instead of contact management:
- **Dashboard**: Action items are the first section (was last). "Log conversation" button in the greeting. Greeting says "Here's what needs your attention."
- **Navigation**: Reduced from 6 tabs to 4 (Home, Activity, Contacts, Actions). Calendar and Inbox moved to icon buttons in the top bar.
- **Contact detail**: Compact header with expand/collapse. Timeline is the default tab (was Action Items). Meetings tab removed (already in Timeline). Persistent pending-actions banner above tabs. "Log conversation" button at the top.
- **Quick-capture modal**: New global modal for logging conversations from anywhere. Pick contacts, select type (coffee/phone/video/etc), add notes, create action items — all in one screen. Accessible via `useQuickCapture()` hook.
- **Action item completion**: Toast now shows "Log conversation" button after completing an item, linking back to the quick-capture modal pre-filled with the contact.
- **Toast system**: Unified `actions` API supporting multiple action buttons per toast.

### ~~Global Toast/Snackbar System~~
Done. `ToastProvider` + `useToast()` hook mounted at the layout level. Supports success/error/info/warning variants, auto-dismiss, and action buttons. Used across all pages.

---

## Infrastructure & Code Quality

### Replace `any` Types with Proper Supabase Types
139 `any` types across the codebase — especially in queries.ts, API routes, and the contacts page. The Supabase SDK generates types from the database schema (already in database.types.ts). Wire these through to catch bugs at compile time instead of runtime.

### CI/CD Pipeline (GitHub Actions)
No automated checks on push or PR. Set up: TypeScript type-check, ESLint, Vitest run, and build verification on every PR. Prevents regressions and enforces quality without manual effort.

### Split queries.ts by Domain
queries.ts is 1,238 lines with 50+ functions covering contacts, meetings, gmail, calendar, and action items. Split into `queries/contacts.ts`, `queries/meetings.ts`, etc. Easier to navigate, smaller imports, clearer ownership.

---

## Performance

### Lean Database Queries
Every contact query fetches all relationships (emails, phones, companies, schools, tags) via `select(*)`. Create query variants: `getContactSummary()` for lists (name + company only), `getContactFull()` for detail views. Reduces payload size and query time as the contact list grows.

### Server Components for Data Fetching
Every page uses `useEffect` → fetch → `setState` (SPA pattern). Next.js 16 supports server components that fetch data before rendering — no loading spinners, no waterfalls, better SEO. Migrate read-heavy pages (dashboard, contacts list, action items) to server components with client islands for interactive parts.

### Rate Limiting on External API Endpoints
Gmail sync, calendar sync, and contact search have no rate limiting. A single misbehaving tab could exhaust Gmail API quotas or overload Supabase. Add rate limiting middleware (e.g., token bucket per user) on sync and search endpoints.

---

## User Experience

### Form Error & Loading States
The contacts page (the app's most-used form) shows no feedback when submission fails — no error message, no loading spinner, no validation highlights. Add error state display, disabled-while-submitting buttons, and field-level validation feedback across all forms.

### Global Search
No way to search across contacts, meetings, interactions, and action items from one place. Add a command-palette style search (Cmd+K) that queries across all entities. Users with 100+ contacts will need this.

### Keyboard Shortcuts
Power users managing lots of contacts want to move fast. Add shortcuts for common actions: N for new contact, E for edit, / for search, Esc to close modals. Low effort, high perceived quality.

### Undo on Destructive Actions
Deleting a contact or completing an action item has no undo. Instead of a confirmation dialog (which users click through), show a toast with an undo button and delay the actual deletion by 5 seconds. Feels faster and safer.

### Dark Mode
The M3 design token system already supports it — `globals.css` has the token structure. Wire up a theme toggle that swaps the CSS custom properties. M3 defines dark variants for every token, so the component layer doesn't need to change.

---

## Features

### Contact Relationship Graph
Track how contacts know each other. "Met Alice through Bob at Company X." Store as a graph (contact_relationships table with source, target, relationship_type). Visualize with a network diagram. Helps users understand their network topology and find warm introductions.

### Smart Follow-Up Suggestions
The app tracks follow-up frequency but only flags overdue contacts. Use interaction history to suggest *who* to reach out to and *why* — "You haven't talked to Sarah in 45 days, and she mentioned she was starting a new role." Could use the existing OpenAI integration to generate personalized outreach suggestions.

### Meeting Prep Briefing
Before a meeting, auto-generate a one-page brief: contact's recent activity, last conversation summary, pending action items, shared connections, and relevant notes. Pull from existing data — no new integrations needed. Surface it as a "Prep" button on upcoming calendar events.

### Email Thread Linking to Contacts
Gmail integration syncs emails but doesn't automatically link them to contacts. Match email addresses to contact_emails records and show the conversation thread on the contact detail page. The data is already there — just needs the join.

### Import/Export
No way to bulk import contacts from CSV/vCard or export data. Users switching from another CRM or spreadsheet need this. Export is also important for data portability and trust.

### Mobile Responsiveness
The app uses fixed-width layouts in several places. Tailwind makes responsive design straightforward — add responsive breakpoints so the app is usable on phones. Networking happens at events, not at desks.

### Tagging & Smart Lists
Tags exist but there are no saved filters or smart lists. Let users save filter combinations ("VCs in NYC I haven't talked to in 30 days") as named lists. Turns the contact page into a lightweight CRM pipeline view.

---

## Security

### Environment Variable Validation at Startup
Env vars are checked at runtime when first used, not at app startup. Use `t3-env` or a Zod schema that runs at build/boot time. Fail fast with clear error messages instead of crashing mid-request when a key is missing.

### Audit Log
No record of who changed what and when. Add an audit trail for sensitive operations (contact deletion, data export, OAuth connections). Useful for debugging, compliance, and multi-user scenarios.

### Content Security Policy Headers
No CSP headers configured. Add them via `next.config.ts` to prevent XSS attacks from injected scripts, especially important since the app renders HTML email content with `dangerouslySetInnerHTML`.

---

## UX/UI Priority Ideas (Claude Instance — Opus 4.6)

### Guided Onboarding & Meaningful Empty States
New users land on an empty dashboard with zero guidance — no contacts, no meetings, no action items, just blank space. This is the highest-friction moment in the entire app. Add a first-time onboarding flow: a 3-step wizard (add your first contact → log your first interaction → set a follow-up reminder) that teaches the core loop by doing it. Beyond onboarding, every empty state across the app (empty contacts list, empty action items, empty inbox before Gmail connect) should show contextual illustrations and a single clear CTA instead of blank white space. Empty states are the app's most common first impression for each feature — they should sell the feature, not look broken.

### Dedicated Contact Profile Page (List → Detail Navigation)
The contacts page is 1,400 lines with expandable inline cards, nested modals, tab systems, and inline action-item editing all crammed into one component. This creates modal fatigue (expand contact → click meeting → edit action item = 3 layers deep) and makes the page sluggish and hard to maintain. Redesign contacts as a two-level navigation: `/contacts` is a clean, scannable list (name, company, last interaction date, follow-up status) and clicking a contact navigates to `/contacts/[id]` — a full dedicated profile page with tabs for Timeline, Meetings, Action Items, Emails, and Contact Info. This mirrors how every modern CRM works (HubSpot, Salesforce, Attio), eliminates the nested-modal problem, gives each contact a shareable URL, and lets the browser handle back-navigation naturally. The profile page can also surface richer data (interaction frequency charts, relationship health score) that would be impossible in the current expandable-card layout.

### Actionable Dashboard — Remaining Ideas
The dashboard redesign is mostly done (action items first, "Reach Out Today", Network Health grid, "Log conversation" button). Remaining ideas: (1) a daily digest summary (auto-generated via the existing OpenAI integration) that says "You have 3 overdue follow-ups, 2 meetings today, and Sarah just started a new role — consider reaching out." (2) Show linked meeting/conversation context on each action item card ("from coffee chat 3/15").

---

## UX/UI Priority Ideas (Claude Instance — Opus 4.6, #2)

### 1. Undo Support on Destructive Actions via Toast
The toast system is done (`ToastProvider` + `useToast()` with action buttons). The remaining piece: use the toast action buttons to implement undo on destructive actions (delete contact, trash email, complete action item) with a 5-second soft-delete delay before committing to the database.

### 2. Multi-Step Contact Form Wizard (Replace the Mega-Modal)
The contact creation/edit modal is a ~900-line mega-form with 15+ fields (name, status, company history, education, multiple emails, multiple phones, tags, location, LinkedIn, follow-up frequency, notes) all crammed into a single scrollable dialog. On mobile it's nearly unusable — users at networking events (the exact moment they need to add a contact) can't quickly capture info. Redesign it as a multi-step wizard: **Step 1** — Name & basics (name, status, industry — the absolute essentials, completable in 10 seconds); **Step 2** — Work & education (companies, schools); **Step 3** — Contact info (emails, phones, LinkedIn); **Step 4** — Relationship context (tags, follow-up frequency, how you met, notes). Each step fits on one mobile screen without scrolling. Add a progress bar, back/next navigation, and the ability to "Save & finish later" at any step. Persist draft state to localStorage so accidental closes don't lose work. The key insight: most contacts start with just a name and company — let users capture that in 10 seconds and enrich later, rather than presenting a wall of fields upfront.

### 3. Accessibility & Keyboard Navigation Overhaul
The app has significant accessibility gaps that affect real users: modals lack focus trapping (focus escapes to background content), there are almost no ARIA attributes (only 2 files use `aria-*`), loading spinners have no `role="status"` or `aria-live` regions, the calendar's drag-to-create is mouse-only with no keyboard alternative, and dropdown/select components don't support arrow-key navigation. This isn't just a compliance checkbox — it affects power users who prefer keyboards, users on screen readers, and anyone with motor impairments. The fix: (1) Add a focus trap to the Modal component with return-focus-on-close, (2) add `aria-labelledby`, `aria-describedby`, and `role="dialog"` to all modals, (3) make all custom Select/Dropdown components navigable with arrow keys and Enter/Escape, (4) add `aria-live="polite"` regions for loading states and toast notifications, (5) add keyboard shortcuts for the calendar (arrow keys to navigate days, Enter to create event), and (6) audit color contrast against WCAG AA. This work makes the app usable by everyone and signals quality to all users — accessible apps feel more polished even to users who don't need the accommodations.

---

## UX/UI Priority Ideas (Claude Instance — Opus 4.6, #3)

### 1. Skeleton Loading Screens & Optimistic UI Updates
Every page currently shows a centered spinner while data loads, creating a jarring blank→content flash that makes the app feel slower than it actually is. Replace all loading spinners with skeleton screens that mirror the actual content layout — gray pulsing rectangles where contact cards, action items, and meeting entries will appear. This eliminates layout shift and gives users the perception of near-instant loading. Beyond loading, implement optimistic updates for mutations: when a user toggles an action item complete, marks a contact as followed-up, or sends an email, update the UI immediately and reconcile with the server response afterward. If the server rejects, roll back with a toast error. The combination of skeletons (perceived load speed) and optimistic updates (perceived interaction speed) would make every touchpoint in the app feel 2-3x faster without changing any backend performance. The M3 design system already has the `animate-pulse` utility — this is a UI-layer change that dramatically improves perceived quality.

### 2. Rich Empty States with Contextual Illustrations & Quick-Start CTAs
Every feature in the app (contacts, meetings, action items, inbox, calendar) starts as a blank white page with no guidance. Empty states are the single most common first impression for each feature, and right now they look broken rather than inviting. Design illustrated empty states for each page: the contacts page should show a friendly illustration of people connecting with a "Add your first contact" button, the action items page should show a checklist illustration with "Create your first task", the inbox should explain Gmail integration with a "Connect Gmail" CTA, and the calendar should show a week grid illustration with "Sync your Google Calendar." Each empty state should have: (1) a custom SVG illustration that matches the M3 green palette, (2) a headline explaining the feature's value ("Track every conversation so nothing falls through the cracks"), (3) a single primary CTA button, and (4) an optional secondary link to docs or a quick-start guide. This transforms dead-end moments into onboarding moments and significantly reduces the "I signed up but I don't know what to do" churn pattern.

### 3. Drag-and-Drop Kanban Board for Action Items & Contact Pipeline
The action items page is a flat list split into two tabs (pending/completed) — functional but passive. Users can't see the shape of their work or prioritize visually. Redesign it as a kanban board with columns: "To Do → In Progress → Waiting on Reply → Done". Users drag action items between columns to update status. Each card shows the linked contact avatar, due date (red if overdue), and a one-line title. Add swimlanes to group by contact or by meeting so users can see all follow-ups for a specific person at a glance. Extend the same pattern to contacts: add a "Pipeline" view on the contacts page with configurable columns like "New → Reaching Out → In Conversation → Strong Connection → Dormant". This turns the CRM from a record-keeping tool into a visual workflow tool — users can see at a glance where every relationship and task stands, and move things forward with a drag. Use a lightweight library like `@dnd-kit/core` (14KB gzipped, React-native, accessible) to avoid building drag-and-drop from scratch. This is the single change most likely to increase daily engagement because it makes managing the pipeline feel tactile and satisfying rather than administrative.
