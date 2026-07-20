# CareerVine - Future Ideas

> Audited 2026-07-19 (CAR-157). Every "the app currently does X" claim below was
> re-checked against the code; items that had shipped were moved to Done and
> stale counts were corrected. If you add an idea, state the current gap in terms
> you can verify, so the next audit can tell whether it still holds.

## Done

### ~~Zod Validation on API Routes~~
Done. Routes go through `withApiHandler()` with Zod schemas, mostly defined in
`src/lib/api-schemas.ts`. Validates input shape, types, and constraints, and
returns structured 400s. Numeric query params use `z.coerce.number()`.
The routes that skip the wrapper are deliberate (QStash signature, machine token,
webhook secret, HMAC, OAuth JWKS) and are enumerated in
`src/__tests__/route-auth-inventory.test.ts`, which fails CI if that list drifts;
current counts live in `careervine/CONVENTIONS.md`, where a test pins them.

### ~~Centralized API Error Handler~~
Done. `withApiHandler()` in `src/lib/api-handler.ts` handles auth, Zod validation,
CORS, error logging, and structured responses across the route layer. Supports
`extensionAuth`, `cors`, and `authOptional`. Reduced ~1,700 lines of duplicated
try/catch boilerplate.

### ~~Conversation-Centric Redesign~~
Done. The app now centers on conversations and action items instead of contact management:
- **Dashboard**: Action items are the first section (was last). "Log conversation" button in the greeting. Greeting says "Here's what needs your attention."
- **Navigation**: Reduced from 6 tabs to 4 (Home, Activity, Contacts, Actions). Calendar and Inbox moved to icon buttons in the top bar.
- **Contact detail**: Compact header with expand/collapse. Timeline is the default tab (was Action Items). Meetings tab removed (already in Timeline). Persistent pending-actions banner above tabs. "Log conversation" button at the top.
- **Quick-capture modal**: New global modal for logging conversations from anywhere. Pick contacts, select type (coffee/phone/video/etc), add notes, create action items, all in one screen. Accessible via `useQuickCapture()` hook.
- **Action item completion**: Toast now shows "Log conversation" button after completing an item, linking back to the quick-capture modal pre-filled with the contact.
- **Toast system**: Unified `actions` API supporting multiple action buttons per toast.

### ~~Global Toast/Snackbar System~~
Done. `ToastProvider` + `useToast()` hook mounted at the layout level. Supports success/error/info/warning variants, auto-dismiss, and action buttons. Used across all pages.

### ~~Split queries.ts by Domain~~ (CAR-146, 2026-07-17)
Shipped as `src/lib/data/{contacts,interactions,meetings,action-items,follow-ups,home,attachments,users}.ts` behind a lazy `db()` client seam, with `queries.ts` kept as a frozen re-export barrel for existing importers.

### ~~CI/CD Pipeline (GitHub Actions)~~
Done. `.github/workflows/ci.yml` runs on every PR and on pushes to `main`, with
four jobs: `web` (typecheck, ESLint at zero warnings, Vitest, `next build`, plus
the ui-events guard), `mcp` (typecheck), `types-drift` (regenerates Supabase types
and fails on a diff), and `extension` (typecheck plus a bundle-freshness gate).

### ~~Rate Limiting on External API Endpoints~~
Done. `src/lib/rate-limit.ts` (Upstash sliding window) covers 17 routes: 14 opt in
through `withApiHandler`'s `rateLimit` option, which returns a 429 carrying
`code: "rate_limited"`, `resetAt`, and a `Retry-After` header; the MCP route calls
`checkRateLimit` directly; and the two admin machine-token routes go through
`checkMachineRateLimit` in `src/lib/admin-auth.ts`.

### ~~Undo on Destructive Actions via Toast~~
Done for action items. `src/hooks/use-deferred-action.ts` implements the
soft-delete pattern with a 5-second default delay and an undo button in the toast,
used on the action-items page and the contact detail page's actions tab. Contact
and meeting deletion still use confirm dialogs rather than deferred undo.

### ~~Smart Follow-Up Suggestions~~
Done. `src/lib/ai-followup/generate-suggestions.ts` plus the `/api/suggestions/*`
routes and `useSuggestions()` surface AI-generated outreach suggestions on the
dashboard.

### ~~Email Thread Linking to Contacts~~
Done. Synced Gmail messages are linked to contacts via `matched_contact_id`,
written by `syncEmailsForContact` and `backfillEmailsForContact` in
`src/lib/gmail.ts`, so conversation history shows on the contact detail page.
(`src/lib/contact-email-history.ts` is the separate, capability-gated fetch layer
for pre-contact history.)

### ~~Guided Onboarding~~
Done, and rebuilt since the original idea was written. New accounts get a guided
first run (curated recruiting bundle, Gmail and Calendar connect, company pick,
first intro email with follow-ups scheduled), backed by a resumable
`users.onboarding_state` and implemented in `src/components/onboarding/` and
`src/lib/onboarding/`. The empty-state polish described alongside it is still
open and is tracked under "Rich Empty States" below.

### ~~Dedicated Contact Profile Page~~
Done. `/contacts/[id]` exists as a full profile page with tabbed Timeline,
Actions, Emails, and Attachments.

---

## Infrastructure & Code Quality

### Replace `any` Types with Proper Supabase Types
Roughly 271 lines match `any` across the codebase (159 excluding `__tests__`),
concentrated in API routes and the contacts page. The Supabase SDK generates types
from the schema (already in `database.types.ts`) and all four client factories are
now `Database`-generic, so the remaining work is wiring those types through call
sites to catch bugs at compile time instead of runtime.

---

## Performance

### Lean Database Queries
Contact list queries fetch all relationships (emails, phones, companies, schools,
tags) via `select(*)`. A `getContactSummary()` variant for lists (name plus company)
would cut payload size as the contact list grows. Note the detail-view counterpart
already exists: `getContactFull()` in `src/mcp/lib/db.ts`.

### More Server Components for Data Fetching
Eight pages are already server components (dashboard, settings, interactions,
inbox, privacy, terms, admin, meetings). The remaining client-rendered, read-heavy
pages still use the `useEffect` to fetch to `setState` pattern and could move to
server components with client islands for the interactive parts.

---

## User Experience

### Global Search
No way to search across contacts, meetings, interactions, and action items from one place. Add a command-palette style search (Cmd+K) that queries across all entities. Users with 100+ contacts will need this.

### Keyboard Shortcuts
Power users managing lots of contacts want to move fast. Add shortcuts for common actions: N for new contact, E for edit, / for search, Esc to close modals. Low effort, high perceived quality.

### Dark Mode
The M3 design token system already supports it: `globals.css` has the token structure. Wire up a theme toggle that swaps the CSS custom properties. M3 defines dark variants for every token, so the component layer doesn't need to change.

---

## Features

### Contact Relationship Graph
Track how contacts know each other. "Met Alice through Bob at Company X." A narrow slice already exists: the `referrals` table stores source/target/meeting/notes and feeds stage derivation. The idea is the general graph beyond referrals (a contact_relationships table with arbitrary relationship types) plus a network-diagram visualization, to surface topology and warm-introduction paths.

### Meeting Prep Briefing
Before a meeting, auto-generate a one-page brief: contact's recent activity, last conversation summary, pending action items, shared connections, and relevant notes. The assembly layer largely exists (the MCP dossier builder already gathers most of this per contact); the remaining work is surfacing it in the web app as a "Prep" button on upcoming calendar events.

### CSV/vCard Import and Data Export
Bulk import already exists for the scraping pipeline and curated bundles
(`/api/contacts/bulk-import`, `/api/contacts/import`, bundle subscriptions). What
is still missing is user-facing CSV/vCard import for people switching from another
CRM or a spreadsheet, and export in any format. Export also matters for data
portability and trust.

### Mobile Responsiveness
A mobile nav already exists; the real gap is content layout, where several grids and tables don't reflow at narrow widths. Tailwind makes responsive design straightforward, so add responsive breakpoints where layouts are still rigid to make the app usable on phones. Networking happens at events, not at desks.

### Outlook / Microsoft 365 Email Integration
Gmail is fully integrated (sync, send, bounce detection); Outlook has nothing. A Microsoft Graph equivalent of the Gmail connection would open the app to the half of candidates whose school or work email lives on Microsoft 365.

### Tagging & Smart Lists
Tags exist but there are no saved filters or smart lists. Let users save filter combinations ("VCs in NYC I haven't talked to in 30 days") as named lists. Turns the contact page into a lightweight CRM pipeline view.

---

## Security

### Environment Variable Validation at Startup
Env vars are checked at runtime when first used, not at app startup. Use `t3-env` or a Zod schema that runs at build/boot time. Fail fast with clear error messages instead of crashing mid-request when a key is missing.

### Audit Log for User-Facing Operations
An `admin_audit_log` table already records admin actions (written through
`writeAudit()`). There is still no trail for user-level sensitive operations such
as contact deletion, data export, and OAuth connect/disconnect, which is what would
help with debugging and compliance.

### Content Security Policy Headers
No CSP headers configured. Add them via `next.config.ts` to prevent XSS attacks from injected scripts, especially important since the app renders HTML email content with `dangerouslySetInnerHTML`.

---

## UX/UI Priority Ideas

### Multi-Step Contact Form Wizard (Replace the Mega-Modal)
The contact creation/edit modal is a 564-line form with 15+ fields (name, status, company history, education, multiple emails, multiple phones, tags, location, LinkedIn, follow-up frequency, notes) in a single scrollable dialog. On mobile it is nearly unusable, and networking events are exactly when users need to add a contact quickly. Redesign it as a multi-step wizard: **Step 1** name and basics (name, status, industry, completable in 10 seconds); **Step 2** work and education; **Step 3** contact info (emails, phones, LinkedIn); **Step 4** relationship context (tags, follow-up frequency, how you met, notes). Each step fits on one mobile screen without scrolling. Add a progress bar, back/next navigation, and "Save & finish later" at any step. Persist draft state to localStorage so accidental closes don't lose work. The key insight: most contacts start with just a name and company, so let users capture that in 10 seconds and enrich later rather than presenting a wall of fields upfront.

### Accessibility & Keyboard Navigation Overhaul
Real gaps remain, corroborated by the 2026-07-17 accessibility audit (19 findings, 7 serious): modals lack focus trapping so focus escapes to background content, `role="dialog"` appears in only 3 production files, most loading spinners lack `role="status"` (two already have it), the calendar's drag-to-create is mouse-only, and custom Select/Dropdown components don't support arrow-key navigation. (ARIA coverage itself is better than this idea originally claimed: about 29 `.tsx` files use `aria-*` attributes, and the toast system already carries `aria-live`.) The fix: (1) add a focus trap to the Modal component with return-focus-on-close, (2) add `aria-labelledby`, `aria-describedby`, and `role="dialog"` to all modals, (3) make custom Select/Dropdown components navigable with arrow keys and Enter/Escape, (4) add `role="status"` / `aria-live="polite"` to the remaining loading states, (5) add calendar keyboard shortcuts, and (6) audit color contrast against WCAG AA. This affects keyboard users, screen-reader users, and anyone with motor impairments, and accessible apps feel more polished even to users who don't need the accommodations.

### Finish the Skeleton Loading Rollout
Real skeletons already exist on the dashboard and the unified action list (about
16 `animate-pulse` usages), and the reversible-write paths already use optimistic
updates with rollback plus a toast. The remaining work is consistency: the pages
still showing a centered spinner (including the email surface, whose "skeleton"
component is actually a spinner) should get skeletons that mirror their real
layout, so the app never flashes blank to content.

### Rich Empty States with Contextual Illustrations & Quick-Start CTAs
Empty states are the most common first impression for each feature, and most still look broken rather than inviting. Design illustrated empty states per page: contacts shows people connecting with "Add your first contact", action items shows a checklist with "Create your first task", inbox explains Gmail integration with "Connect Gmail", calendar shows a week grid with "Sync your Google Calendar." Each should have (1) a custom SVG illustration matching the M3 green palette, (2) a headline explaining the feature's value, (3) a single primary CTA, and (4) an optional secondary link to docs. This turns dead ends into onboarding moments.

### Daily Digest and Action-Item Context
The dashboard redesign is largely done (action items first, "Reach Out Today", Network Health grid, "Log conversation" button), and a discovery digest card already ships. Remaining: (1) a daily digest summary generated from the existing OpenAI integration ("You have 3 overdue follow-ups, 2 meetings today, and Sarah just started a new role"), and (2) linked meeting/conversation context on each action item card ("from coffee chat 3/15").

### Drag-and-Drop Kanban Board for Action Items & Contact Pipeline
The action items page is a flat list split into two tabs (pending/completed), functional but passive. Users can't see the shape of their work or prioritize visually. Redesign it as a kanban board with columns: "To Do, In Progress, Waiting on Reply, Done". Users drag action items between columns to update status. Each card shows the linked contact avatar, due date (red if overdue), and a one-line title. Add swimlanes to group by contact or by meeting so users can see all follow-ups for a specific person at a glance. Extend the same pattern to contacts with a "Pipeline" view: "New, Reaching Out, In Conversation, Strong Connection, Dormant". Use a lightweight library like `@dnd-kit/core` to avoid building drag-and-drop from scratch. This is the single change most likely to increase daily engagement because it makes managing the pipeline feel tactile rather than administrative.
