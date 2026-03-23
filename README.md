# CareerVine

A personal CRM I built from scratch to solve my own problem: I was having great conversations (coffee chats, informational interviews, networking events) and then losing track of the follow-ups. Existing tools were either too heavy (Salesforce) or too generic (spreadsheets). So I built something purpose-fit.

**Live at [careervine.app](https://careervine.app)**

## The problem

Professional relationships compound, but only if you maintain them. After a few months of networking, I had dozens of contacts and no system for remembering what I promised, who I owed a follow-up, or when I last spoke to someone. The cost of a dropped follow-up is invisible. You just never hear back.

## How CareerVine solves it

The core insight is that **conversations are the atomic unit of a relationship**, not contacts. Everything in CareerVine flows from logging a conversation: action items are created in context, follow-ups are tracked against the last touchpoint, and email history fills in the gaps automatically.

### Key workflows

- **Log a conversation, capture what matters** — One unified modal, accessible from anywhere in the app. Log a past meeting with notes, transcripts, and AI-generated action items — or schedule a future meeting with Google Calendar invites, Meet links, and private reminder notes. The same clean interface whether you're on the dashboard, a contact's profile, or the activity page.
- **Never drop a follow-up** — Set a cadence per contact (weekly, monthly, quarterly). The two-column dashboard shows your action items, overdue contacts, and AI suggestions on the left with network health on the right. Mark tasks done, log interactions, and save suggestions without ever leaving the page.
- **One-click LinkedIn import** — A Chrome extension scrapes a LinkedIn profile and saves the contact with work history, education, and photo. No manual data entry.
- **Email as a first-class feature** — Threaded Gmail inbox, AI-powered composition, scheduled sends, and multi-stage follow-up sequences that auto-cancel when the person replies.
- **Calendar that knows your network** — Google Calendar sync with week and list views. Create a meeting in CareerVine and it generates a Calendar event with Meet link and attendee invites.
- **Transcripts to notes** — Upload audio or paste a transcript. AI-powered speaker matching identifies who said what by analyzing conversation context, roles, and names — with confidence scores and one-click confirmation instead of tedious manual dropdowns.
- **"Waiting on" tracking** — After a conversation, the AI extracts not just your action items but also what the other person committed to doing for you. These show up in a separate "Waiting on others" section. After 7 days, the app nudges you to send a gentle follow-up — so you never forget to cash in on an offer of help.

### Design decisions I'm proud of

- **Inline editing for high-frequency actions.** Email and follow-up cadence are editable directly on the contact card (hover to reveal, click to edit, blur to save). Inspired by the Chrome extension's pattern of making inputs look like display text until interaction. No edit mode needed for the two most common actions.
- **Relationship health as a ratio, not a date.** The dashboard doesn't show "last contacted 10 days ago." It shows a color based on the ratio of days since contact to the cadence you set. A 30-day cadence touched 10 days ago is green; a 7-day cadence touched 10 days ago is red. Same number, completely different urgency.
- **Follow-up sequences that respect replies.** Multi-stage email sequences auto-cancel when the recipient responds. Before each scheduled send, the system checks the Gmail thread for new replies and cancels the entire sequence if one is found. You never accidentally nag someone who already got back to you.
- **AI email drafts grounded in real conversations.** The AI compose feature optionally pulls in meeting notes and transcripts as context, with a 32KB token budget to keep quality high. The prompt explicitly blocks generic phrases like "I stumbled upon" to keep emails sounding like you actually wrote them.
- **Conversation-first data model.** Action items link back to the meeting where you made the promise. Timeline shows everything chronologically across meetings, emails, and interactions. A task isn't just a task — it's a record of a commitment you made to a specific person at a specific time.
- **Chrome extension that doesn't fight the host page.** The LinkedIn sidebar uses a closed Shadow DOM with `all: initial` on the host element, so LinkedIn's CSS can't leak in and the extension can't break LinkedIn. Profile photos are extracted with a three-tier fallback strategy (400x400 first, URL rewrite from 100x100, graceful null). Duplicate detection runs before scraping even starts.
- **One modal for everything.** Past coffee chat? Future informational interview? Same modal, different fields. The unified conversation modal adapts to context: past dates show notes, transcript upload, and AI action item extraction. Future dates show private reminder notes, Google Calendar integration, and attendee invites. Eight conversation types, multi-contact support, and direction-aware action items (your tasks vs. what you're waiting on).

## Tech stack

| Layer | Tech |
|-------|------|
| Framework | Next.js 16 (App Router, React 19) |
| Language | TypeScript |
| Styling | Tailwind CSS 4, custom Material Design 3 component library |
| Database | Supabase (Postgres + Row Level Security) |
| Auth | Supabase Auth |
| APIs | Gmail API, Google Calendar API, OpenAI API, Deepgram API |
| Rich text | Tiptap editor |
| Testing | Vitest + React Testing Library (356 tests) |
| Deployment | Vercel |
| Browser extension | Chrome Manifest V3, Shadow DOM isolation |

## Architecture

```
careervine/           Next.js app
  src/
    app/              12 pages + 45 API routes
    components/       Custom M3 component library
    lib/              Database queries, types, utilities
    hooks/            Custom React hooks

chrome-extension/     LinkedIn import extension
  src/                Content scripts, background worker
  panel-app/          React sidebar panel (injected into LinkedIn)

supabase/
  migrations/         28 database migrations
```

## Local development

```bash
cd careervine
npm install
npm run dev
```

Requires environment variables for Supabase, Google OAuth, OpenAI, and Deepgram.
