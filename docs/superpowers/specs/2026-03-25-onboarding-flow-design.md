# Onboarding Flow Design Spec

## Overview

A hands-on, guided onboarding experience for new CareerVine users. Instead of a passive tour, users complete real actions — connecting integrations, importing a contact, sending an AI-drafted email, logging a conversation, and extracting action items — so they experience the full value loop before they're left on their own.

The goal: get users to their "aha" moment as fast as possible by walking them through CareerVine's core workflow with a safety-net contact (Dawson Pitcher).

## UI Pattern

**Floating Guide Card** — a draggable card (default: bottom-right corner, ~400px wide) that overlays the real app. The app remains fully interactive behind it.

- **Draggable:** Users can click-and-drag to reposition the card if it covers something they need.
- **Position resets** to bottom-right on each new step.
- **Persists across route changes** — lives in the root layout component.
- **Element highlighting:** For steps pointing to a specific UI element, a subtle pulse animation + colored ring draws attention to the target via `data-onboarding-target` attributes.
- **Semi-transparent overlay** dims the rest of the page on steps requiring focus on a specific element (not fully blocking).
- **"Skip tutorial"** link always visible in the card footer — marks onboarding complete.

### Card Anatomy

- **Header bar:** "Getting Started" label, step counter (e.g., "3/14"), drag handle indicator
- **Title:** Bold step name
- **Description:** 1-2 sentences explaining what to do
- **CTA area:** Primary action button + optional secondary/skip button
- **Progress bar:** Thin bar at the bottom showing overall completion percentage
- **Expandable area:** Used in step 11 for the transcript display with copy button

### Step Transitions

- Card content crossfades between steps
- If user navigates away from the expected page, card nudges: "Head back to [page] to continue the tutorial"
- On page refresh, state loads from database and resumes at current step

## Onboarding Flow (14 Steps)

### Step 1: Connect Gmail
- **Card text:** "Let's connect your Gmail so you can send and read emails right from CareerVine."
- **CTA:** Button triggers Gmail OAuth flow
- **Advances when:** OAuth completes successfully

### Step 2: Connect Google Calendar
- **Card text:** "Now let's connect your Google Calendar. CareerVine will sync your events and help you prepare for meetings."
- **CTA:** Button triggers Google Calendar OAuth
- **Advances when:** OAuth completes successfully

### Step 3: Install CareerVine Chrome Extension (required)
- **Card text:** "Install the CareerVine extension to import contacts directly from LinkedIn."
- **CTA:** Opens Chrome Web Store in new tab: `https://chromewebstore.google.com/detail/careervine-linkedin-integ/kckdmkjjfcnjlhilgdgfggpgodlmbacd`
- **Confirmation:** "I've installed it" button
- **Advances when:** User confirms installation

### Step 4: Install Apollo.io Extension (suggested, skippable)
- **Card text:** "We also recommend Apollo.io — it finds contact emails so you can enrich your LinkedIn imports. This is optional but highly recommended."
- **CTA:** Opens Apollo Chrome Web Store in new tab: `https://chromewebstore.google.com/detail/apolloio-free-b2b-phone-n/alhgpfoeiimagjlnfekdhkjlkiomcapa`
- **Buttons:** "I've installed it" and "Skip for now"
- **Advances when:** Either button clicked

### Step 5: Import a Contact from LinkedIn (required)
- **Card text:** "Head to LinkedIn, find someone in your network, and use the CareerVine extension to save them. If you have Apollo installed, grab their email too!"
- **No CTA button** — user navigates to LinkedIn themselves
- **Confirmation:** "I've imported a contact" button
- **Advances when:** User confirms (ideally detect new contact creation as fallback)

### Step 6: Click Intro Button for Dawson
- **Card text:** "Nice work! You could email your new contact now, but let's practice first. See Dawson Pitcher in your action list? Click the intro button to draft your first AI-powered email."
- **Highlights:** Pulses the intro button for Dawson on the home page
- **Advances when:** User clicks the intro button and email composer opens

### Step 7: Compose & Send with AI
- **Card text:** "Use the AI composer to draft your intro email to Dawson. Set up follow-up emails too — CareerVine will automatically send them if Dawson doesn't reply."
- **Advances when:** Email is sent successfully

### Step 8: Read Dawson's Reply in Inbox
- **Behind the scenes:** Simulated reply from Dawson appears in the thread
- **Card text:** "Dawson replied! Head to your Inbox to read it. Notice that your follow-up emails have been automatically cancelled since you got a reply."
- **Highlights:** Inbox nav item
- **Advances when:** User navigates to inbox and views the thread

### Step 9: Return to Home Page — See the Meeting
- **Behind the scenes:** Google Calendar event created ("Networking Chat with Dawson Pitcher", ended ~30 min ago, ~45 min duration) + matching CareerVine meeting record
- **Card text:** "Head back to your home page. We've added a networking chat with Dawson to your Google Calendar — check your schedule to see it."
- **Highlights:** Home nav item
- **Advances when:** User navigates home and meeting is visible in the day view

### Step 10: Click the Meeting
- **Card text:** "Click on the meeting with Dawson to add notes from your conversation."
- **Highlights:** The meeting card in the day view
- **Advances when:** User clicks the meeting and transcript upload area is visible

### Step 11: Copy & Paste the Transcript
- **Card expands** to show the full sample transcript with a **copy button** in the top-right corner
- **Card text:** "Here's a transcript from your call with Dawson. Copy it and paste it into the transcript field."
- **Transcript content:** Dynamically replaces `{firstName}` with the user's actual first name (see Appendix A)
- **Advances when:** Transcript is pasted into the field

### Step 12: Extract Action Items
- **Card text:** "Now hit 'Analyze' to let AI extract the action items from your conversation. This is the magic."
- **Highlights:** The analyze/extract button
- **Advances when:** AI extraction completes and action items appear

### Step 13: Back to Dashboard — See Action Items
- **Card text:** "Head back to your dashboard. Your action items are waiting for you — this is your command center."
- **Highlights:** Home nav item
- **Advances when:** User navigates home and action items are visible

### Step 14: Wispr Flow Recommendation
- **Card text:** "One last thing — check out Wispr Flow. It's a voice dictation app that makes capturing meeting notes effortless. Full disclosure: this is my referral link. You'll get an extra free month, and I'll get one too."
- **CTA:** "Check it out" links to `https://wisprflow.ai/r?DAWSON59`
- **Secondary:** "I'm good, let's go"
- **Advances on either** → onboarding complete, card animates away

## Data Model

### New table: `user_onboarding`

| Column | Type | Purpose |
|--------|------|---------|
| `user_id` | uuid (PK, FK → users) | One row per user |
| `version` | integer NOT NULL DEFAULT 1 | Onboarding flow version — used to evolve the flow without breaking in-progress users |
| `current_step` | text NOT NULL | Step identifier (e.g., `connect_gmail`, `install_extension`) |
| `started_at` | timestamptz NOT NULL DEFAULT now() | When onboarding began |
| `completed_at` | timestamptz | Null until finished |
| `skipped_apollo` | boolean DEFAULT false | Whether they skipped the Apollo install step |
| `onboarding_calendar_event_id` | text | Google Calendar event ID for cleanup on completion |

**Version logic:** Frontend checks the version. Users mid-onboarding on v1 finish v1's flow even after v2 ships. New signups always get the latest version. Can also be used to offer returning users a "what's new" tour.

### Step identifiers (v1)

1. `connect_gmail`
2. `connect_calendar`
3. `install_cv_extension`
4. `install_apollo_extension`
5. `import_linkedin_contact`
6. `click_intro_button`
7. `compose_send_email`
8. `read_reply`
9. `view_meeting`
10. `click_meeting`
11. `paste_transcript`
12. `extract_actions`
13. `view_dashboard_actions`
14. `wispr_recommendation`

## Backend Logic

### Seed Data on Signup

When a new user account is created:
1. Create a contact record: **Dawson Pitcher**, Senior Business Analyst, Deloitte, `dawson@careervine.app`
2. Create a `user_onboarding` row with `version = 1`, `current_step = 'connect_gmail'`

### Simulated Reply from Dawson

When an email is sent to `dawson@careervine.app`:
1. Check `user_onboarding` — only trigger on the first email to this address from this account
2. After a short delay (~3-5 seconds), insert a simulated inbound `email_messages` row into the same thread:
   - `direction`: `'inbound'`
   - `from_address`: `dawson@careervine.app`
   - `to_address`: user's Gmail address
   - `thread_id`: same thread as the sent email
   - `is_simulated`: `true` (new boolean column on `email_messages` to flag synthetic messages)
   - The inbox query will naturally surface it since it's a standard `email_messages` row
3. Reply content:

> "Hey! Thanks for reaching out — welcome to CareerVine. I built this to help people like you stay on top of their network. Excited to have you here. Let me know if you ever want to chat about networking strategies!"

### Meeting Insertion (Step 9)

When the user reaches step 9:
1. Create a Google Calendar event via the Calendar API:
   - Title: "Networking Chat with Dawson Pitcher"
   - End time: ~30 minutes before current time
   - Duration: ~45 minutes
2. Store the Google Calendar event ID in the `user_onboarding` row (new column: `onboarding_calendar_event_id text`) for cleanup
3. Create a matching CareerVine meeting record linked to the Dawson contact
4. Sync so it appears in the home page day view

**Cleanup:** When onboarding completes (or is skipped), delete the Google Calendar event using the stored event ID so the user's calendar isn't cluttered with a fake past event. The CareerVine meeting record remains as their first logged conversation.

## Frontend Component

### `<OnboardingGuide />`

- Lives in the root layout — renders on every page when onboarding is incomplete
- Reads `current_step` from the `user_onboarding` table (fetched on mount, cached in context)
- Renders the draggable floating card with step-specific content
- Applies highlight CSS class to elements with matching `data-onboarding-target` attribute
- Updates `current_step` in the database when advancing
- On completion: animates the card away, sets `completed_at`

### Step Configuration

Each step defined as a config object:
```
{
  id: string,
  title: string,
  description: string,
  page: string (expected route),
  highlightTarget?: string (data-onboarding-target value),
  primaryAction?: { label, handler },
  secondaryAction?: { label, handler },
  skippable: boolean,
  advanceCondition: 'manual' | 'automatic' (detected by the app)
}
```

## Edge Cases

- **User refreshes mid-onboarding:** State reloads from `user_onboarding` table, resumes at current step
- **User navigates to wrong page:** Card nudges "Head back to [page] to continue"
- **User skips tutorial:** "Skip tutorial" footer link → sets `completed_at`, removes card
- **User closes browser and returns later:** Picks up exactly where they left off
- **OAuth failure:** Card shows retry option, doesn't advance
- **Extension detection:** We can't reliably detect Chrome extensions from the web app, so we use confirmation buttons as the primary mechanism

## Appendix A: Sample Transcript

The transcript dynamically replaces `{firstName}` with the user's first name from their profile.

```
Dawson: Hey, thanks so much for hopping on this call. So you're studying Information Systems, right? Tell me a little about where you're at in your program.

{firstName}: Yeah, I'm a junior at the University of Georgia. I'm majoring in MIS and I've been trying to figure out what direction I want to go after graduation. I know IS is broad, so I've been doing a lot of these calls to learn about different paths.

Dawson: That's really smart. Honestly, most people don't start networking until they're desperate for a job, so you're way ahead. What's caught your eye so far?

{firstName}: I think I'm most interested in the consulting side of things. I like the idea of solving problems for different companies rather than being stuck at one. But I honestly don't know that much about what the day-to-day looks like.

Dawson: Yeah, that's a great question. So I'm a Senior Business Analyst at Deloitte, and I've been here about six years now. The day-to-day really depends on the project. Right now I'm on an ERP implementation for a healthcare client, so my days are a lot of requirements gathering, stakeholder interviews, process mapping — that kind of thing.

{firstName}: That sounds really interesting. What did your path look like getting there? Did you go straight into consulting out of school?

Dawson: Not exactly. I actually started at a mid-size company doing IT support, which I know sounds unglamorous, but it taught me so much about how businesses actually use technology. After about a year and a half I moved into a business analyst role at the same company, and then Deloitte recruited me from there. So it wasn't a straight line, but every step made sense in hindsight.

{firstName}: That's really encouraging to hear. A lot of people make it sound like you have to land a Big Four internship or you're behind.

Dawson: Not at all. I mean, internships help for sure, but what really matters is that you can show you understand both the business side and the technical side. That's the sweet spot for IS people. Can you talk to a CIO and also understand what the developers are building? That's the skill.

{firstName}: That makes a lot of sense. So what skills would you say I should be focusing on right now to be competitive for a role like yours?

Dawson: SQL is a must — you'd be surprised how many analysts can't write a decent query. Get comfortable with data visualization too, Tableau or Power BI. And honestly, the soft skills matter just as much. Learn to run a meeting, write a clear email, present to people who don't care about technology. Those things separate the good analysts from the great ones.

{firstName}: I've been learning SQL in my database class actually, but I haven't touched Tableau yet. Any recommendations on how to get started?

Dawson: Tableau has a free version called Tableau Public. Just download it, grab a public dataset, and build something. Put it on your LinkedIn. Hiring managers love seeing that. Actually, my friend Sarah Chen runs the analytics practice at our Atlanta office — she literally teaches a Tableau workshop for new hires. I could introduce you to her if you want. She's great with students.

{firstName}: Oh wow, that would be incredible. I'd really appreciate that.

Dawson: Yeah, send me your resume and I'll shoot her an email. Just make sure your LinkedIn is updated too — she's going to look at it.

{firstName}: Absolutely, I'll send my resume over tonight and clean up my LinkedIn this weekend. Should I connect with her on LinkedIn too, or wait for your intro first?

Dawson: Wait for my intro — I'll CC you on the email so it's a warm handoff. Then you can connect with her right after and reference the email. That's always the smoothest way to do it.

{firstName}: Got it. That's a really good tip actually. I've been cold-connecting with people and the response rate is pretty low.

Dawson: Yeah, warm intros are everything. That's literally why networking matters — it's not about collecting contacts, it's about building a chain of trust. Someone vouches for you, that person vouches for you to the next person, and so on.

{firstName}: That's a great way to think about it. One more question — do you have any book or resource recommendations? I want to make sure I'm learning the right things outside of class.

Dawson: Definitely read "The McKinsey Way" by Ethan Rasiel. It's technically about management consulting, but the frameworks for structured problem-solving apply to any analyst role. It completely changed how I approach client problems.

{firstName}: I'll check that out. Is that something I could find at the library or should I just buy it?

Dawson: It's on Amazon for like fifteen bucks. Totally worth it. And honestly, if you want to go deep on the technical side, look into getting a Tableau Desktop Specialist certification. It's not hard if you practice, and it looks great on a resume for entry-level roles.

{firstName}: That's awesome advice. I'm going to look into both of those this week. Dawson, this has been so helpful. I really appreciate you sharing all of this.

Dawson: Absolutely. You're asking the right questions, which tells me you're going to do well. Let me get that intro to Sarah set up for you this week, and don't hesitate to reach out if you have more questions down the road.

{firstName}: Will do. Thanks again, Dawson. Have a great rest of your day.

Dawson: You too! Good luck with everything.
```

### Expected AI-extracted action items:
1. **Send resume to Dawson tonight** (user's task)
2. **Dawson intros user to Sarah Chen at Deloitte Atlanta** (waiting on Dawson)
3. **Connect with Sarah Chen on LinkedIn after intro email** (user's task)
4. **Update LinkedIn profile this weekend** (user's task)
