# Settings Page Redesign

## Problem Statement

The current settings page is a flat list of 5 cards stacked vertically with no grouping or navigation. Users have to scroll through everything to find what they need. More critically, new users don't realize they need to connect Gmail and Google Calendar — they just see broken features with no guidance.

## Current Structure (flat list)
1. Profile (name, email, phone)
2. Change Password
3. Email Integration (Gmail connect/disconnect/sync)
4. Availability (Google Calendar + working hours)
5. AI Email Templates

---

## Plan

### Phase 1: Sidebar Navigation + Grouped Sections

Replace the single scrolling page with a **left sidebar nav + content area** layout (common settings pattern).

**Sidebar tabs:**
- **Account** — Profile + Password (the "about me" stuff)
- **Integrations** — Gmail + Google Calendar connections (the "connect your stuff" section)
- **Availability** — Working hours + busy calendars (only meaningful once Calendar is connected)
- **AI Templates** — Custom email generation prompts

This gives the page clear information architecture. Users looking for "how do I connect Gmail" go straight to Integrations. Users editing their name go to Account. No scrolling through calendar availability configs to find the disconnect button.

**Layout:** On desktop, sidebar is a fixed left column (~200px) with the content area taking the rest. On mobile, the sidebar becomes horizontal tabs at the top (scrollable if needed).

### Phase 2: Onboarding Setup Banner (Global)

Add a **persistent setup banner** that appears at the top of every page (below Navigation) when Gmail or Calendar is not connected. This is the key fix for new users not knowing they need to connect.

**Banner design:**
- Amber/warning-toned bar (not red — it's not an error, it's a setup step)
- Icon + text: "Complete your setup: Connect Gmail and Google Calendar to unlock email tracking and scheduling."
- Two inline action buttons: "Connect Gmail" / "Connect Calendar" (only showing whichever isn't connected yet)
- Dismissible with an X, but reappears on next session until actually connected
- Disappears entirely once both are connected

**Where it lives:** New component `SetupBanner` rendered in the app layout (or in Navigation component), checks connection status via the existing `/api/gmail/connection` endpoint.

### Phase 3: Google OAuth "Unverified App" Warning

Since CareerVine is not a verified Google app, users hit the "This app isn't verified" scary screen. We need to prepare them for it.

**In the Integrations section (Settings page):**
- Below each "Connect Gmail" / "Connect Google Calendar" button, add an info callout:
  - Light blue/info background
  - Shield icon
  - Text: "CareerVine is currently in the Google verification process. When connecting, Google will show a warning screen. Click 'Advanced' then 'Go to CareerVine (unsafe)' to continue. Your data is only used within your CareerVine account."

**In the global setup banner:**
- After the user clicks a connect button, they'll land on Google's OAuth page, so the warning needs to be visible *before* they click. Add a small "(Why will Google show a warning?)" link next to each connect button that expands an inline tooltip/popover with the same explanation.

### Phase 4: Feature-Level "Not Connected" Indicators

When users try to use features that require Gmail/Calendar without being connected:

**Inbox page** (already has a full empty state — keep it, but enhance):
- Current: generic "Go to Settings" button
- New: Direct "Connect Gmail" button that goes to `/api/gmail/auth` + the unverified app warning text

**Meetings page:**
- When calendar is not connected: show an inline banner at the top explaining that Calendar features require connection, with a direct "Connect Google Calendar" link

**Navigation bar:**
- Currently hides the Inbox icon when Gmail isn't connected — this makes the feature invisible instead of discoverable
- Change: Always show the Inbox icon, but show a small indicator dot or tooltip "Connect Gmail to use Inbox"
- Same for Calendar icon if calendar isn't connected

**Compose email (from contact pages):**
- If Gmail not connected and user tries to compose: show a modal/toast explaining they need to connect Gmail first, with a link to the Integrations settings section

### Phase 5: Polish & Component Extraction

- Extract each settings section into its own component file to keep the page manageable (currently 987 lines in one file):
  - `settings/account-section.tsx` — profile + password
  - `settings/integrations-section.tsx` — Gmail + Calendar connections
  - `settings/availability-section.tsx` — working hours + busy calendars
  - `settings/templates-section.tsx` — AI email templates
- The parent `settings/page.tsx` becomes a thin shell: sidebar nav + renders the active section

---

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `app/settings/page.tsx` | Rewrite | Sidebar nav layout + section routing |
| `components/settings/account-section.tsx` | New | Profile + password forms |
| `components/settings/integrations-section.tsx` | New | Gmail + Calendar connect/disconnect with OAuth warnings |
| `components/settings/availability-section.tsx` | New | Working hours + busy calendars |
| `components/settings/templates-section.tsx` | New | AI email templates |
| `components/setup-banner.tsx` | New | Global "complete your setup" banner |
| `app/layout.tsx` or `components/navigation.tsx` | Edit | Include SetupBanner |
| `app/inbox/page.tsx` | Edit | Enhance not-connected state with direct OAuth link + warning |
| `app/meetings/page.tsx` | Edit | Add not-connected banner when calendar missing |
| `components/navigation.tsx` | Edit | Always show Inbox/Calendar icons with "not connected" indicators |

## Implementation Order

1. Extract settings sections into components (refactor, no visual change)
2. Add sidebar navigation layout to settings page
3. Add Google OAuth unverified app warnings to Integrations section
4. Build and integrate the global SetupBanner component
5. Add feature-level "not connected" indicators (nav icons, inbox, meetings)
6. Test all flows end-to-end
