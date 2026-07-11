# CareerVine

A personal CRM I built from scratch to solve my own problem: I was having great conversations (coffee chats, informational interviews, networking events) and then losing track of the follow-ups. Existing tools were either too heavy (Salesforce) or too generic (spreadsheets). So I built something purpose-fit.

**Live at [careervine.app](https://careervine.app)**

## The problem

Professional relationships compound, but only if you maintain them. After a few months of networking, I had dozens of contacts and no system for remembering what I promised, who I owed a follow-up, or when I last spoke to someone. The cost of a dropped follow-up is invisible. You just never hear back.

## How CareerVine solves it

The core insight is that **conversations are the atomic unit of a relationship**, not contacts. Everything in CareerVine flows from logging a conversation: action items are created in context, follow-ups are tracked against the last touchpoint, and email history fills in the gaps automatically.

### Key workflows

- **A first session that ends with real outreach sent** — New accounts don't land on an empty dashboard. A guided first run offers a curated recruiting database (real PMs, recruiters, and BYU alumni at companies that hire new grads) and drops you straight into browsing its companies — ranked by how many alumni you'd know there — the moment you accept, while the import streams in on a progress bar and you connect Gmail and Calendar. Picking your first target unlocks as soon as the import finishes, and from there it's a pre-written, personalized intro email with follow-ups already scheduled. Alumni get an alumni-to-alumni version automatically, everything is editable before send, and none of it needs an AI key. Ten minutes after signing up, your first networking email is out — and its follow-ups cancel themselves if the person replies. The getting-started checklist that greets a new account is yours to tailor, too: dismiss any step you don't need and it stays gone, on every device you sign in from.
- **Log a conversation, capture what matters** — One unified modal, accessible from anywhere in the app. Log a past meeting with notes, transcripts, and AI-generated action items — or schedule a future meeting with Google Calendar invites, Meet links, and private reminder notes. The same clean interface whether you're on the dashboard, a contact's profile, or the activity page.
- **Never drop a follow-up** — Set a cadence per contact (weekly, monthly, quarterly). The two-column dashboard shows your action items, overdue contacts, and AI suggestions on the left with network health on the right. Mark tasks done, log interactions, and save suggestions without ever leaving the page.
- **One-click LinkedIn import** — A Chrome extension scrapes a LinkedIn profile and saves the contact with work history, education, and photo. No manual data entry. New accounts get a ready-made to-do on their dashboard that walks them through it live: install the extension, import a real contact from LinkedIn (the page advances itself the moment the contact lands), then — optionally — pair it with Apollo.io to pull the person's work email, so every future import is someone you can actually reach.
- **Email as a first-class feature** — Threaded Gmail inbox, AI-powered composition, scheduled sends, and multi-stage follow-up sequences that auto-cancel when the person replies.
- **Calendar that knows your network** — Google Calendar sync with week and list views. Create a meeting in CareerVine and it generates a Calendar event with Meet link and attendee invites.
- **Transcripts to notes** — Upload audio or paste a transcript. AI-powered speaker matching identifies who said what by analyzing conversation context, roles, and names — with confidence scores and one-click confirmation instead of tedious manual dropdowns.
- **"Waiting on" tracking** — After a conversation, the AI extracts not just your action items but also what the other person committed to doing for you. These show up in a separate "Waiting on others" section. After 7 days, the app nudges you to send a gentle follow-up — so you never forget to cash in on an offer of help.
- **Company pages built for recruiting** — Look up any company and see who in your network works there now and who used to, faceted by office location (Google as a whole, or just Google San Diego). Target companies get their own dashboard with priority scores, program names, application dates, and a timestamped recruiting-intel log — so everything you learn on a call lands somewhere you'll find it again. Spot a company you want to chase before you know anyone there? Add it in seconds from the Companies page — name, optional LinkedIn URL and office — and it lands straight on your target list, deduped against every company already in your network.
- **Bulk import from a scraping pipeline** — An API built to ingest hundreds of reviewed LinkedIn profiles at once, complete with emails, full work history, and education. Imports are merge-safe (re-running never clobbers your manual edits), deduped by canonical LinkedIn URL, and office locations are inferred automatically from where people say they work.
- **A network that stays curated at scale** — Imported prospects live in their own tier, and lower-priority people sit on a collapsed "bench," so 70 scraped profiles at one company never bury the five you actually plan to contact. Follow-up nags, AI suggestions, and network health only ever look at your real network; one click promotes a bench person into your outreach queue, and the first real touch graduates anyone into it automatically. When you decide someone belongs in your circle, an "Add to network" button — right on the contact list and the profile page — moves them into your active network instantly, no conversation log required.
- **Outreach that protects your sender reputation** — Every contact shows a live outreach stage derived from real activity (contacted, replied, call scheduled, referral). Bounced addresses are detected from Gmail delivery failures, flagged distinctly, and their pending follow-up sequences are cancelled automatically. Pattern-guessed addresses get a warning before you hit send, and a daily send cap keeps Gmail deliverability healthy.
- **An AI operator for your whole network** — Connect Claude from [Settings → Integrations](https://www.careervine.app/settings?tab=integrations) via the hosted MCP server at `https://www.careervine.app/api/mcp` (OAuth-protected, scoped to your account), or use the local stdio server in [`careervine-mcp/`](careervine-mcp/) for development. Ask in plain English: "who do I know at Samsara? draft the recruiter an intro" — Claude pulls a full dossier and writes a real Gmail draft. Work the outreach queue, log interactions, manage action items, and schedule meetings under the same guardrails as the app: drafts by default, confirm-gated sends, the daily cap, and bounced-address refusal.
- **Bring your own AI keys** — Use your own accounts so AI usage bills to you, not us. Add an **OpenAI** key for every text feature (email drafts, transcript parsing, follow-up suggestions, LinkedIn import parsing) and/or a **Deepgram** key for audio/video transcription — they're independent, so set either or both. Every key is encrypted at rest, never sent back to your browser, and validated with a live test before saving. With OpenAI's free daily tokens, most people pay nothing.
- **AI that never fails silently** — When an AI feature can't run — your key is out of quota, was rejected, or you haven't added one yet — the feature tells you exactly what's wrong right where you're working, with a one-click path to fix it in Settings, instead of a spinner that never resolves or a cryptic error. If you've been granted access to CareerVine's shared keys, a hiccup with your own key falls back to them seamlessly; otherwise you're guided to add your own in seconds.
- **A network that grows itself** — Once a week, CareerVine quietly searches your highest-priority target companies for product people who joined in the last 90 days — the warmest cold outreach there is, because new hires are actively building their networks and just ran the exact hiring gauntlet you're targeting. Fresh finds surface as a small "New PM hires" card on the company page and a one-line digest on your dashboard ("3 new PMs just joined Qualtrics"). One click adds someone as a prospect — complete with photo, title, and auto-enriched profile — and one click dismisses them forever. People you already know never show up, spend is capped to pocket change, and the whole feature is off until an admin turns it on per account.
- **Subscribe to curated prospect lists** — New users shouldn't start from an empty CRM. Data subscriptions (Settings → Data subscriptions) let anyone import curated bundles — say, every IB analyst at the NYC boutiques, plus the banks and their offices — straight into their contacts as ready-to-work prospects. Bundles are living subscriptions: when the bundle is updated with new people or corrected emails, subscribers receive the changes automatically within minutes, and the merge only ever fills in blanks — nothing you've edited is ever overwritten. Unsubscribing is just as respectful: keep everything, or remove only the contacts you never touched (anyone you've emailed, tagged, or annotated always stays).

### Design decisions I'm proud of

- **Inline editing for high-frequency actions.** Email and follow-up cadence are editable directly on the contact card (hover to reveal, click to edit, blur to save). Inspired by the Chrome extension's pattern of making inputs look like display text until interaction. No edit mode needed for the two most common actions.
- **Relationship health as a ratio, not a date.** The dashboard doesn't show "last contacted 10 days ago." It shows a color based on the ratio of days since contact to the cadence you set. A 30-day cadence touched 10 days ago is green; a 7-day cadence touched 10 days ago is red. Same number, completely different urgency.
- **Follow-up sequences that respect replies.** Multi-stage email sequences auto-cancel when the recipient responds. Before each scheduled send, the system checks the Gmail thread for new replies and cancels the entire sequence if one is found. You never accidentally nag someone who already got back to you.
- **AI email drafts grounded in real conversations.** The AI compose feature optionally pulls in meeting notes and transcripts as context, with a 32KB token budget to keep quality high. The prompt explicitly blocks generic phrases like "I stumbled upon" to keep emails sounding like you actually wrote them.
- **Conversation-first data model.** Action items link back to the meeting where you made the promise. Timeline shows everything chronologically across meetings, emails, and interactions. A task isn't just a task — it's a record of a commitment you made to a specific person at a specific time.
- **Chrome extension that doesn't fight the host page.** The LinkedIn sidebar uses a closed Shadow DOM with `all: initial` on the host element, so LinkedIn's CSS can't leak in and the extension can't break LinkedIn. Profile photos are extracted with a three-tier fallback strategy (400x400 first, URL rewrite from 100x100, graceful null). Duplicate detection runs before scraping even starts.
- **One modal for everything.** Past coffee chat? Future informational interview? Same modal, different fields. The unified conversation modal adapts to context: past dates show notes, transcript upload, and AI action item extraction. Future dates show private reminder notes, Google Calendar integration, and attendee invites. Eight conversation types, multi-contact support, and direction-aware action items (your tasks vs. what you're waiting on).
- **Product analytics built around outcomes, not clicks.** Every surface — web app, Chrome extension, and the MCP server — reports into one event system keyed to a single north-star metric: replies received. Funnels track a new user from extension install to their first five contacts and first five companies emailed; every AI draft records whether it was sent as-is, edited (and how much), or discarded; and business-critical outcomes (sends, replies, meetings) are mirrored into CareerVine's own database so the data outlives any analytics vendor.

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
| Testing | Vitest + React Testing Library (468 tests) |
| Deployment | Vercel |
| Browser extension | Chrome Manifest V3, Shadow DOM isolation |

## Architecture

```
careervine/           Next.js app
  src/
    app/              14 pages + 61 API routes
    components/       Custom M3 component library
    lib/              Database queries, types, utilities
    hooks/            Custom React hooks

chrome-extension/     LinkedIn import extension
  src/                Content scripts, background worker
  panel-app/          React sidebar panel (injected into LinkedIn)

supabase/
  migrations/         38 database migrations
```

## Local development

```bash
cd careervine
npm install
npm run dev
```

Requires environment variables for Supabase, Google OAuth, OpenAI, Deepgram, and (for BYO OpenAI/Deepgram keys) `BYOK_ENCRYPTION_KEY` — generate with `openssl rand -base64 32` and add to Vercel + `.env.local`. The same `BYOK_ENCRYPTION_KEY` encrypts both providers' keys; `OPENAI_API_KEY` and `DEEPGRAM_API_KEY` are the shared fallbacks.
