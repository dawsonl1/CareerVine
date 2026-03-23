# Home Page Redesign

**Goal:** Redesign the home page from the ground up, driven by user stories that reflect what users most often need when they open the app.

**Approach:** Define and refine user stories first, then derive the design from them — not the other way around.

---

## Phase 1: User Stories

### High-frequency (every visit)

Here are the top reasons someone will open the app:

---

### Persona 1: "I just had a conversation and want to log it." 

**Context:** The user just finished a call, coffee, event, or meeting. The conversation is fresh and they want to capture it before details fade.

**User stories:**
- As a user, I want to immediately log a conversation so I don't lose details.
- As a user, I want to capture action items that came out of the conversation so I can follow through on promises I made.
- As a user, I want to associate the conversation with the right contact(s) so it's tracked against the relationship.
- As a user, I want logging to be fast (under 30 seconds) so it doesn't feel like a chore.

**What the home page needs for this persona:**
- A prominent, instantly accessible "Log conversation" entry point — this should be one of the first things they see.
- The flow should pre-fill or suggest contacts to minimize friction.

---

### Persona 2: "I just added contacts from LinkedIn and want to take action on them."

**Context:** The user was browsing LinkedIn, used the Chrome extension to save a few new contacts into CareerVine, and now they've opened the app to do something with those contacts.

**User stories:**
- As a user, I want to see my recently added contacts so I can act on them while the context is fresh.
- As a user, I want to log an initial interaction or note for a new contact so I remember how/where we connected. Important. 
- As a user, I want to set a follow-up cadence for new contacts so they don't fall off my radar. This is less important. We can set follow-up cadence through the Chrome extension. 
- As a user, I want to send an introductory or follow-up message to a new contact so I can start building the relationship. Very important - especially for the Chrome extension contacts that were recently added that already have emails associated with them .

**What the home page needs for this persona:**
- A "recently added contacts" section that surfaces new contacts who haven't had a first interaction logged yet.
- For each new contact, three distinct quick actions:
  1. **Log first interaction** — opens the conversation logger to record how you met / what you discussed.
  2. **Add a note** — separate from logging an interaction; a quick way to jot down context about the person (e.g., "Met at SaaStr, interested in AI tooling").
  3. **Send intro message** — a separate button that opens the compose email modal with an AI-drafted introductory message already written and ready to review/send. Only shown for contacts that have an email address.
- Cadence setting is *not* a priority here — the Chrome extension already handles that. The home page should focus on these three high-value actions.

---

### Persona 3: "I have a few free minutes — what's the most productive networking thing I can do right now?"

**Context:** The user has a gap in their day — waiting for a meeting, on a break, commuting. They want the app to tell them what to do, not figure it out themselves.

**User stories:**
- As a user, I want the app to tell me my highest-priority action so I can be effective without thinking.
- As a user, I want to see overdue action items so I can fulfill commitments I'm behind on.
- As a user, I want to see which relationships are going stale so I can reach out before it's too late.
- As a user, I want AI-suggested actions (who to contact, what to say) so I can act immediately without planning.
- As a user, I want to be able to complete an action (send a message, mark done, log a call) directly from the home page so I don't waste my limited time navigating.

**What the home page needs for this persona:**
- A single, unified "What should I do next?" section — **not** separate lists for action items, stale relationships, and AI suggestions. All of these are answers to the same question ("what should I do?") and belong in one place.
- This unified list should blend together:
  - Action items I need to complete (things I promised people)
  - Contacts whose relationships are going stale (cadence-based outreach)
  - AI-suggested outreach (proactive reconnection ideas)
- Items should be priority-sorted across all types so the most important thing is always at the top, regardless of whether it's an action item, a stale relationship, or an AI suggestion.
- Each item should show the **contact's profile picture** so the user can quickly associate the action with a person.
- Each item should have inline actions so the user can act immediately without navigating away.
- Although they live in one list, each item type must be **visually distinct** — through icons, color coding, labels, or card styling — so the user can instantly tell whether something is an action item, a stale relationship nudge, or an AI suggestion at a glance. Filter buttons at the top of the list must let the user quickly filter to just one type (e.g., "Action Items" / "Reach Out" / "Suggestions" / "All").

---

### Persona 4: "I want to audit my recent networking activity and plan ahead."

**Context:** The user is in a reflective mode — maybe it's Sunday evening or the start of a week. They want to see what they've been doing and whether they're on track.

**User stories:**
- As a user, I want to see a summary of my recent activity (conversations logged, action items completed, people contacted) so I can assess my effort.
- As a user, I want to see my overall network health so I know if I'm maintaining relationships or letting them slip.
- As a user, I want to identify gaps — who haven't I talked to in too long? What action items have I been ignoring?
- As a user, I want to feel a sense of progress and momentum so I stay motivated to keep networking.

**What the home page needs for this persona:**
- **Networking activity heatmap** — a GitHub-style contribution graph (day-of-week × weeks) where each cell's intensity represents networking activity for that day (conversations logged, action items completed, messages sent). At a glance, the user can see: "Am I consistently networking, or did I fall off for two weeks?" This replaces both the health snapshot and progress indicators — it's one visual that answers "how am I doing?" through the pattern of effort over time.
- The heatmap should use a color intensity scale (less → more) so denser activity periods are immediately visible.
- **Key counters/stats** — compact numbers that give an instant pulse. Examples:
  - Conversations logged this week / this month
  - Action items completed vs. outstanding
  - Contacts added this month
  - Messages sent this week
  These should be simple, glanceable numbers — not charts. Think scoreboard.
- **Network status breakdown** — a visual (pie chart, donut, or horizontal bar) showing what proportion of your contacts are healthy vs. overdue vs. never contacted. This answers "what does the overall state of my network look like?" as opposed to the heatmap which answers "how active have I been?"
- **Trend indicator** — a simple directional signal (up/down/flat) comparing this week's activity to last week's, so the user can see if they're improving or slipping without doing the math themselves.
- **Neglected relationships callout** — specifically surface contacts that have gone significantly past their cadence. Not mixed into the unified action list — this is a reflective view, showing "these are the relationships you're letting slip" as a group so the user can see the pattern and plan.

---

### Persona 5: "I know I have networking stuff today — let me see what's on deck."

**Context:** The user is starting their day or prepping for an upcoming block of time. They know they have meetings, follow-ups, or action items due today but can't remember the specifics. They want to see their agenda so they can prepare.

**User stories:**
- As a user, I want to see action items due today so I know exactly what I committed to.
- As a user, I want to see which contacts I'm scheduled to interact with so I can prep for those conversations.
- As a user, I want to review notes and history for today's contacts so I walk into conversations informed, not cold.
- As a user, I want to see what's due soon (next few days) so I can plan ahead if I have extra time today.

**What the home page needs for this persona:**
- A **today's calendar view** integrated into the home page — pulling in the user's calendar events for the day so they can see their scheduled meetings/calls at a glance.
- For each calendar event that involves a known contact, show quick access to that contact's context (last conversation, open action items) so the user can prep before walking into the meeting.
- Action items due today should also be visible here or in the unified action list (Persona 3) filtered to today.

---

## Answers to Open Questions

- **Priority ordering:** The persona ordering doesn't necessarily reflect frequency of use — all five are common entry points depending on the moment.
- **Scope:** All five personas belong on the home page.
- **Completeness:** No missing stories — these five cover the space.
- **Target user:** Someone with a large contact base who has gone through phases of power networking. The home page should serve power networkers well, but also be helpful and guided enough that a beginner feels supported and grows into power networking through using it.

---

## Phase 2: Design

### Aesthetic Direction

The home page should feel like a tool that respects your time. Not a dashboard you admire — a workspace you use. Clean, quiet, and dense where it matters. The design earns trust by showing you exactly what you need and nothing else.

Key principles:
- **The action list is king** — it gets the most real estate and the most prominent position. Everything else supports it. The user's eye should land here first every time.
- **Flat and clean over layered and busy** — no unnecessary elevation, shadows, or card chrome. Rows with subtle dividers beat floating cards. White space does the work of visual separation, not borders.
- **Three bands, three modes** — the page has a natural top-to-bottom flow: orient (header stats), act (action list + schedule + new contacts), reflect (networking stats). Each band serves a different mindset and the user scrolls deeper only when they want to shift modes.
- **Information density over decoration** — every element must answer a question the user has. The heatmap, donut, and counters are functional first. If they also look good, great — but they're never there just for visual texture.
- **One dominant action** — "Log conversation" is a button in the header, right-aligned next to the greeting. This is the single most common reason someone opens the app, so it lives at the top where the user sees it immediately — not a floating FAB that competes with the action list.

---

### Desktop Layout (≥1024px)

The page is organized into three horizontal bands, each full-width, creating a clear top-to-bottom reading flow with varied visual weight. This avoids the cramped sidebar problem and gives every section the space it needs.

**Band 1 — Header:** Greeting — just the name, nothing else competing for attention
**Band 2 — Workspace:** Action list (wide) + Schedule & New Contacts (narrow) — where you spend your time
**Band 3 — Reflection:** Stats + heatmap + donut + neglected contacts — scroll down when you want to reflect

```
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│  Hey, Dawson                                        [⊕ Log conversation] │
│                                                                          │
├──────────────────────────────────────────────┬───────────────────────────┤
│                                              │                           │
│  What should I do next?                      │  TODAY                    │
│                                              │                           │
│  [All] [Action Items (4)] [Reach Out (3)]   │   9:00  Coffee w/ Sarah  │
│  [Suggestions (2)]                           │         ○ Sarah Chen      │
│                                              │         Last: 3 days ago  │
│  ┌────────────────────────────────────────┐  │                           │
│  │ ○ Alex Rivera               [✓]  [→] │  │  11:00  Call w/ Mike      │
│  │   Send proposal · Due today           │  │         ○ Mike Torres     │
│  │   ACTION ITEM                         │  │         Last: 3 weeks ago │
│  ├────────────────────────────────────────┤  │                           │
│  │ ○ Mike Torres              [📝] [✉]  │  │   2:00  Team Lunch        │
│  │   5 days overdue · Last: 3 weeks      │  │                           │
│  │   REACH OUT                           │  │   4:00  Intro call — Lisa │
│  ├────────────────────────────────────────┤  │         ○ Lisa Park       │
│  │ ○ Lisa Park          [✓] [Save] [✕]  │  │         No prior history   │
│  │   45 days since contact               │  │                           │
│  │   SUGGESTION                          │  ├───────────────────────────┤
│  ├────────────────────────────────────────┤  │                           │
│  │                                        │  │  NEW CONTACTS             │
│  │  ... more items ...                    │  │                           │
│  │                                        │  │  ○ Jamie Park             │
│  │                                        │  │    [Log] [Note] [✉ Intro] │
│  │                                        │  │                           │
│  │                                        │  │  ○ Rachel Kim             │
│  │                                        │  │    [Log] [Note] [✉ Intro] │
│  │                                        │  │                           │
│  │                                        │  │  ○ David Okafor           │
│  │                                        │  │    [Log] [Note]           │
│  │                                        │  │                           │
│  └────────────────────────────────────────┘  └───────────────────────────┘
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Your Networking                                                         │
│                                                                          │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐   │
│  │  12           │ │   4          │ │   8          │ │   6          │   │
│  │  conversations│ │   pending    │ │   contacts   │ │   messages   │   │
│  │  this week ↑3 │ │   items  ↓2  │ │   added  ↑5  │ │   sent   →   │   │
│  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘   │
│                                                                          │
│  ┌──────────────────────────────────┐  ┌───────────┐  ┌────────────────┐│
│  │  ░░░░░▓▓░░░▓▓▓█████▓▓▓         │  │           │  │  Needs         ││
│  │  ░░░░░░▓░░░░▓▓▓████▓▓░         │  │    🍩     │  │  Attention     ││
│  │  ░░░░░░░░░░░░▓▓████▓░░         │  │    142    │  │                ││
│  │  ░░░░▓░░░░▓░░░▓▓███▓░░         │  │           │  │  ○○○ +2 more  ││
│  │  ░░░░░░░░░░░░░▓████▓▓░         │  │  58% ok   │  │  past cadence  ││
│  │  Activity · 12 weeks             │  │  24% due  │  │                ││
│  │                                  │  │  18% new  │  │                ││
│  └──────────────────────────────────┘  └───────────┘  └────────────────┘│
│                                                                          │
│  This week vs last: ↑ 23% more active                                   │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

**Scroll behavior:** The entire page scrolls as one unit — no independently scrolling panels or sections. This keeps navigation simple and predictable.

**Container width:** `max-w-7xl` (1280px) — uniform across every page in the app (including nav, home, activity, contacts, action items, settings, calendar, contact detail, contact preview, privacy, and landing page).

**Grid structure:** Three bands stacked vertically. Band 2 uses CSS Grid `grid-template-columns: 1fr 340px`. Band 3 uses CSS Grid `grid-template-columns: 1fr auto auto` to lay out heatmap, donut, and neglected contacts side by side. At narrower desktop widths (1024–1200px), the donut and neglected contacts wrap below the heatmap (CSS Grid `grid-template-columns: 1fr 1fr` with heatmap spanning full width on its own row) to avoid cramping.

**Zone breakdown:**

#### Zone 1: Header (full width — Band 1)
- **Greeting:** "Hey, [first name]" — large, warm typography on the left. No subtitle, no stats, no clutter. The header's job is to feel personal and get out of the way so your eye goes straight to the action list below.
- **"Log conversation" button** — right-aligned in the header row, next to the greeting. Primary color, icon + label. Serves Persona 1. No floating action button — the header button is sufficient and keeps the page clean.

#### Zone 2: Unified Action List (left column of Band 2 — THE CENTERPIECE)
- **Section title:** "What should I do next?" — conversational, not shouty
- **Filter bar:** Horizontal row of pill-shaped filter chips: `All` | `Action Items (4)` | `Reach Out (3)` | `Suggestions (2)`
  - Active filter gets filled primary style; inactive gets outlined
  - Counts are inline with the label, not separate badges — cleaner
- **List items:** Each item is a row in a continuous list (not separate floating cards — this reduces visual noise and makes scanning faster). Rows are separated by subtle dividers. Each row contains:
  - **Contact avatar** (40px, circular) on the left
  - **Primary line** — contact name, bold
  - **Secondary line** — what needs to happen + context: "Send proposal · Due today" or "5 days overdue · Last: 3 weeks"
  - **Type label** — small uppercase text below the secondary line: "ACTION ITEM" / "REACH OUT" / "SUGGESTION" in the type's color
  - **Left edge color bar** — thin 3px vertical accent on the left edge of the row:
    - Orange (`#e8a838`) = Action Item
    - Red/coral (`#e05555`) = Reach Out (stale relationship)
    - Teal (`#39656b`, our tertiary) = AI Suggestion
  - **Inline actions** — right-aligned, contextual per type. **All types** support snooze (clock icon — hides the item for a chosen duration: 1 day, 3 days, 1 week) and done/complete (checkmark). Additional actions per type:
    - Action Items: checkmark (complete), snooze (clock), arrow (go to contact)
    - Reach Out: checkmark (mark as done / reached out), snooze (clock), message icon (log interaction), email icon (draft message)
    - Suggestions: checkmark (did it — opens conversation logger to capture the interaction), snooze (clock), bookmark (save for later), X (dismiss permanently)
- Rows have a subtle hover background change (not elevation — keeps it flat and clean)
- The entire page scrolls as one unit — no independently scrolling sections. The action list is naturally the tallest element and dominates the viewport, but everything moves together when the user scrolls.
- This is where the user spends 80% of their time on this page
- **Empty state (new user onboarding):** When the action list has no real items (brand new user with no contacts, action items, or suggestions), the list area shows onboarding steps styled as action list items — same row format with left color bars, icons, and inline actions so the user learns the UI pattern immediately:
  1. **Install the Chrome extension** — "Add contacts from LinkedIn in one click" · left bar: teal · action: link to Chrome Web Store
  2. **Connect Google Calendar** — "See today's meetings with contact context" · left bar: amber · action: opens Google Calendar OAuth flow
  3. **Log your first conversation** — "Capture a recent interaction before details fade" · left bar: green (primary) · action: opens conversation logger
  - As the user completes steps and real data flows in, onboarding items are replaced by real action items organically. No separate onboarding page — the home page *is* the onboarding.

#### Zone 3: Today's Schedule (right column of Band 2, top)
- **Section title:** "Today"
- **Clean event list** — not a proportional timeline. A timeline wastes space on gaps and empty hours. A list is faster to scan and more information-dense. Each event shows:
  - **Time** — left-aligned, muted color
  - **Event title** — bold, next to time
  - **Contact context** (if a known contact is involved):
    - Avatar (small, 24px) + name
    - One line of prep context: "Last: 3 days ago" or "No prior history" — this is the key value, letting the user know if they need to prep
  - Events without a known contact just show time + title (no contact row)
- If no calendar connected: a gentle, non-intrusive prompt to connect Google Calendar
- If no events today: show "Nothing scheduled today" with a calm, positive tone
- Serves Persona 5

#### Zone 4: New Contacts (right column of Band 2, bottom)
- **Section title:** "New Contacts" with a count
- Shows contacts added in the last 7 days that have no logged interactions
- Each contact: avatar (32px), name, and action buttons on the same line:
  - **Log** (icon: message-square) — opens conversation logger
  - **Note** (icon: pencil) — opens a quick note input
  - **Intro** (icon: mail) — opens compose modal with AI-drafted intro. **Only shown if the contact has an email address** (David Okafor in the wireframe has no email, so no Intro button).
- Compact rows, not cards — consistent with the action list's flat style
- If no new contacts: this section hides entirely (no empty state needed — the space collapses)
- Serves Persona 2

#### Zone 5: Your Networking (full width — Band 3)
- Lives below the fold. The user scrolls here when they want to reflect, not when they want to act. This is intentional — reflection mode is a different mindset than action mode.
- **Section title:** "Your Networking"
- **Stat cards** across the top of the section — four compact metric cards in a horizontal row:
  - Conversations this week (with trend arrow ↑↓→)
  - Pending action items (with trend)
  - Contacts added (with trend)
  - Messages sent (with trend)
  - Each card: large number, muted label, colored trend indicator (green up, red down, gray flat)
  - These give a quick numerical pulse before the user digs into the visuals below
- **Below the stats**, three elements laid out horizontally with generous spacing:
  1. **Activity Heatmap** (takes the most width): GitHub-style grid, 12 weeks × 7 days. Color intensity uses primary green scale:
     - No activity: `#f0f0f0`
     - Light: `#d4e8d0` (secondary-container)
     - Medium: `#94d58f` (inverse-primary)
     - Heavy: `#2d6a30` (primary)
     - Hover on a cell shows tooltip: "March 15: 3 conversations, 2 action items completed"
  2. **Network Health Donut** (compact, ~120px): Shows proportion of contacts by health:
     - Healthy (green), Overdue (coral/red), Never contacted (gray)
     - Center of donut shows total contact count
     - Legend beside or below the donut with percentages
  3. **Neglected Contacts Callout**: If any contacts are 2x+ past their cadence, show "N relationships need attention" with a small avatar stack and a link to view them. If none are neglected, this space shows a positive message ("All caught up") or simply doesn't render.
- **Trend line** below the three elements: "This week vs last: ↑ 23% more active" — one sentence with directional arrow
- Serves Persona 4

---

### Tablet Layout (768px–1023px)

Same three-band structure. Band 2's right column drops below the action list. Schedule and New Contacts sit side by side in their own row.

```
┌─────────────────────────────────────┐
│  Hey, Dawson                        │
├─────────────────────────────────────┤
│  What should I do next?             │
│  [All] [Actions] [Reach] [Suggest]  │
│  ... action list (full width) ...   │
├──────────────────┬──────────────────┤
│  TODAY           │  NEW CONTACTS    │
│  9:00 Coffee..   │  ○ Jamie Park    │
│  11:00 Call..    │  ○ Rachel Kim    │
├──────────────────┴──────────────────┤
│  Your Networking                    │
│  [stats row]                        │
│  [heatmap]   [donut]  [neglected]  │
└─────────────────────────────────────┘
```

---

### Mobile Layout (<768px)

Single column, prioritized by frequency:

```
┌─────────────────────┐
│ Hey, Dawson  [⊕ Log] │
├─────────────────────┤
│ WHAT SHOULD I DO?    │
│ [filters...]         │
│ ... action list ...  │
├─────────────────────┤
│ TODAY'S SCHEDULE     │
├─────────────────────┤
│ NEW CONTACTS         │
├─────────────────────┤
│ YOUR NETWORKING      │
└─────────────────────┘
```

On mobile:
- The action list remains the primary focus
- "Log conversation" button stays in the header row, always at the top
- Calendar, new contacts, and networking stats (with counters) stack below
- Sections below the fold are collapsible (tap header to expand/collapse)

---

### Visual Details & Micro-interactions

**Action list items:**
- On hover: subtle background tint change (keeps it flat — no elevation/shadow), left color bar widens from 3px → 5px
- Completing an action: card slides left and fades out (200ms ease), list items below animate up to fill the gap
- New items (from AI suggestions loading): fade in from top with subtle downward slide

**Stat counters:**
- Numbers animate up from 0 on page load (countUp effect, staggered 100ms per card)
- Trend arrows pulse once on load to draw attention

**Heatmap:**
- Cells fade in with a staggered wave animation (left to right) on first render
- Hover on a cell shows a tooltip: "March 15: 3 conversations, 2 action items completed"

**New contacts:**
- Cards enter with a subtle slide-up stagger when the section first becomes visible

---

### Component Architecture

```
src/app/page.tsx (orchestrator — data fetching, layout grid)
├── components/home/
│   ├── greeting-header.tsx        (Zone 1: name + context)
│   ├── unified-action-list.tsx    (Zone 2: THE centerpiece)
│   │   ├── action-filter-bar.tsx  (filter chips)
│   │   └── action-list-item.tsx   (individual action card)
│   ├── today-schedule.tsx         (Zone 3: calendar view)
│   ├── new-contacts.tsx           (Zone 4: recently added)
│   ├── networking-stats.tsx       (Zone 5: wrapper)
│   │   ├── activity-heatmap.tsx   (GitHub-style grid)
│   │   ├── stat-counters.tsx      (key metrics, lives with heatmap)
│   │   ├── network-donut.tsx      (health donut chart)
│   │   └── trend-indicator.tsx    (week-over-week comparison)
│   └── (Log conversation button lives in greeting-header.tsx)
```

---

### Color System for Action Types

| Type | Left Bar | Badge BG | Badge Text | Icon |
|------|----------|----------|------------|------|
| Action Item | `#e8a838` (amber) | `#fef3c7` | `#92400e` | CheckSquare |
| Reach Out | `#e05555` (coral) | `#fee2e2` | `#991b1b` | Phone |
| AI Suggestion | `#39656b` (teal/tertiary) | `#bcebf1` | `#001f23` | Sparkles |

These colors are intentionally distinct from the primary green, creating clear visual separation while remaining harmonious within the M3 palette.

---

### What This Design Achieves Per Persona

| Persona | How the design serves them |
|---------|---------------------------|
| 1. Log a conversation | "Log conversation" button in the header — visible immediately on page load |
| 2. Act on new contacts | Right column surfaces them with contextual action buttons (Log/Note/Intro) |
| 3. Free minutes | Unified action list dominates the page with filters + inline actions |
| 4. Audit/reflect | Scroll to "Your Networking" for the full picture: stats + heatmap + donut + trend + neglected contacts |
| 5. What's today | Clean schedule list in right column shows events with contact prep context |

---

## Phase 3: Implementation

### Data Layer (new queries needed)

1. **`getRecentContacts(userId)`** — contacts created in last 7 days with no meetings or interactions. Join `contacts` left-join `meeting_contacts` and `interactions`, filter where both are null.
2. **`getHomeStats(userId)`** — single function returning: conversations this week (meetings count), pending action items count, contacts added this week, messages sent this week. Also returns last week's values for trend comparison.
3. **`getActivityHeatmap(userId)`** — daily activity counts for last 12 weeks (84 days). Aggregates meetings, completed action items, and sent emails by date.
4. **`getNetworkHealthSummary(userId)`** — counts contacts by health status (healthy/overdue/never contacted) using existing `getHealthColor` logic.
5. **`getNeglectedContacts(userId)`** — contacts 2x+ past their cadence, sorted by severity.
6. **Today's calendar events** — use existing `/api/calendar/events` endpoint with today's date range, then match attendees to known contacts for prep context.

### Build Order

1. **Data layer** — add queries to `queries.ts`, create `/api/home/stats` endpoint for aggregated data
2. **greeting-header.tsx** — simplest component, greeting + Log button
3. **unified-action-list.tsx** — THE centerpiece. Merges action items + reach out contacts + AI suggestions into one priority-sorted list with filter chips and inline actions
4. **today-schedule.tsx** — calendar events with contact context
5. **new-contacts.tsx** — recently added contacts with Log/Note/Intro actions
6. **networking-stats.tsx** — stat counters + heatmap + donut + neglected callout + trend
7. **page.tsx rewrite** — orchestrator that fetches data and renders the 3-band layout

### Key Reuse

- `getActionItems()` → action items for unified list
- `getContactsDueForFollowUp()` → reach out items for unified list
- `useSuggestions()` → AI suggestions for unified list
- `getHealthColor()` → health classification for donut
- `getContactsWithLastTouch()` → last touch data for multiple components
- `useQuickCapture()` → log conversation from header button + action items
- `useCompose()` → draft email for reach out + new contact intro
- `useContactsWithEmails()` → email lookup for new contacts intro button
- `/api/calendar/events` → today's schedule


