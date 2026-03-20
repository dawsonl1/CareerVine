# CareerVine

A personal CRM I built from scratch to solve my own problem: I was having great conversations (coffee chats, informational interviews, networking events) and then losing track of the follow-ups. Existing tools were either too heavy (Salesforce) or too generic (spreadsheets). So I built something purpose-fit.

**Live at [careervine.app](https://careervine.app)**

## The problem

Professional relationships compound, but only if you maintain them. After a few months of networking, I had dozens of contacts and no system for remembering what I promised, who I owed a follow-up, or when I last spoke to someone. The cost of a dropped follow-up is invisible. You just never hear back.

## How CareerVine solves it

The core insight is that **conversations are the atomic unit of a relationship**, not contacts. Everything in CareerVine flows from logging a conversation: action items are created in context, follow-ups are tracked against the last touchpoint, and email history fills in the gaps automatically.

### Key workflows

- **Log a conversation, capture what matters** — Quick-capture from anywhere in the app. Notes, attendees, and action items are tied to the conversation where they happened, not floating in a vacuum.
- **Never drop a follow-up** — Set a cadence per contact (weekly, monthly, quarterly). The dashboard shows who's overdue with color-coded health indicators so you can prioritize at a glance.
- **One-click LinkedIn import** — A Chrome extension scrapes a LinkedIn profile and saves the contact with work history, education, and photo. No manual data entry.
- **Email as a first-class feature** — Threaded Gmail inbox, AI-powered composition, scheduled sends, and multi-stage follow-up sequences that auto-cancel when the person replies.
- **Calendar that knows your network** — Google Calendar sync with week and list views. Create a meeting in CareerVine and it generates a Calendar event with Meet link and attendee invites.
- **Transcripts to notes** — Upload audio or paste a transcript. Speakers are identified and matched to attendees, so your meeting notes write themselves.

### UX decisions I'm proud of

- **Inline editing for high-frequency actions.** Email and follow-up cadence are editable directly on the contact card (hover to reveal, click to edit, blur to save). Inspired by the Chrome extension's pattern of making inputs look like display text until interaction. No edit mode needed for the two most common actions.
- **Contact profile as two-column layout.** Sticky sidebar with identity and contact info, main column with activity tabs. Keeps context visible while you scroll through timeline and emails.
- **Conversation-first data model.** Action items link back to the meeting where you made the promise. Timeline shows everything chronologically across meetings, emails, and interactions.
- **Follow-up sequences that respect replies.** Multi-stage email sequences auto-cancel when the recipient responds, so you never accidentally nag someone who already got back to you.

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
| Testing | Vitest + React Testing Library (278 tests) |
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
