# CareerVine

A full-stack personal CRM for managing professional relationships. Built to solve a real problem: keeping track of every conversation, follow-up, and promise across a growing network.

**Live at [careervine.app](https://careervine.app)**

## What it does

CareerVine tracks the people you meet and the conversations you have with them. Log a coffee chat, and it reminds you to send that intro you promised. Set a follow-up cadence, and it tells you when a relationship is going cold. Connect Gmail, and your email history with each contact appears automatically.

### Core features

- **Conversation logging** — Record meetings with notes, attendees, and file attachments. Quick-capture modal lets you log from anywhere in the app.
- **Action items** — Turn "I'll send you that article" into a tracked task with a due date, linked back to the conversation where you said it.
- **Follow-up cadences** — Set per-contact frequencies (weekly, monthly, quarterly). Dashboard shows who's overdue with color-coded health indicators.
- **Gmail integration** — Full inbox with threading, AI-powered email composition, scheduled sending, and multi-stage follow-up sequences that auto-cancel on reply.
- **Google Calendar sync** — Week/list views, drag-to-create meetings, auto-generated Google Calendar events with Meet links and attendee invites.
- **Transcript processing** — Upload audio files or paste VTT/SRT transcripts. Speakers are identified and matched to meeting attendees.
- **Contact profiles** — Two-column card layout with inline editing for email and follow-up cadence (no edit mode needed for common actions). Full work history, education, tags, and interaction timeline.
- **Chrome extension** — Visit a LinkedIn profile, click import. Name, company, education, photo, and work history are scraped and saved in one click.

## Tech stack

| Layer | Tech |
|-------|------|
| Framework | Next.js 16 (App Router, React 19) |
| Language | TypeScript |
| Styling | Tailwind CSS 4, Material Design 3 color system |
| Database | Supabase (Postgres + Row Level Security) |
| Auth | Supabase Auth |
| APIs | Gmail API, Google Calendar API, OpenAI API, Deepgram API |
| Rich text | Tiptap editor |
| Testing | Vitest + React Testing Library |
| Deployment | Vercel |
| Browser extension | Chrome Manifest V3, Shadow DOM isolation |

## Architecture

```
careervine/           Next.js app
  src/
    app/              Pages + 45 API routes
    components/       UI components (custom M3 component library)
    lib/              Database queries, types, utilities
    hooks/            Custom React hooks

chrome-extension/     LinkedIn import extension
  src/                Content scripts, background worker
  panel-app/          React sidebar panel (injected into LinkedIn)

supabase/
  migrations/         28 database migrations
```

## Project stats

- ~150 TypeScript source files
- 45 API routes
- 12 pages
- 278 tests
- 28 database migrations
- Chrome extension with LinkedIn scraping + Shadow DOM panel

## Local development

```bash
cd careervine
npm install
npm run dev
```

Requires environment variables for Supabase, Google OAuth, OpenAI, and Deepgram. See `.env.example` if present, or check the API route files for required keys.
