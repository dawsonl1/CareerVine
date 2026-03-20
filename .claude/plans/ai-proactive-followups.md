# AI Proactive Follow-Up Drafts

## The Idea

When a contact's follow-up cadence comes due, an AI agent automatically:
1. Reads all context about the contact (notes, meeting transcripts, interaction history)
2. Extracts personal interests, hobbies, or topics from past conversations
3. Searches the web and iterates until it finds an article that would genuinely resonate
4. Drafts a short, natural follow-up email referencing that content
5. Surfaces the draft for the user to review and send with one click

The goal: make follow-ups feel genuine and personal, not templated — while requiring almost zero effort from the user.

---

## How It Would Work (End to End)

### Step 1: Trigger — On Login

Generation happens **when the user loads the dashboard**. The system checks for contacts that are due for follow-up (via existing `getContactsDueForFollowUp()`) and kicks off generation in the background for any that don't already have a pending draft.

**Why on-login, not cron:**
- No background infrastructure to maintain (no Edge Functions, no cron auth complexity)
- The user is present and can see drafts appear in real-time
- Avoids the security complexity of a system-level job that iterates all users
- Drafts are always fresh — generated with the latest context

**UX approach:**
- Dashboard loads immediately with existing data (action items, reach-out contacts, health grid)
- A skeleton/loading indicator shows in the integrated draft slots while generation runs
- Drafts populate as they complete (no layout shift — space is reserved)
- Generation runs via async API calls, capped at ~3 contacts per login to keep it fast

### Step 2: Context Gathering

For each due contact, pull everything we know:

- **Contact profile**: name, role, industry, companies, schools, location
- **Meeting notes** (`meetings.notes` via `meeting_contacts`) — prioritize recent, cap at 5 most recent meetings
- **Transcript segments** (`transcript_segments` via meetings) — the gold mine for small talk topics
- **Interaction history** (`interactions.summary`)
- **Contact notes** (`contacts.notes`)
- **Previous email threads** (`email_messages` matched to contact)

**Token budget:** Cap total context at ~8,000 tokens. Prioritize recent meetings over old ones. Use transcript segments (structured format) over raw transcripts where available. Summarize/truncate older meetings. This keeps the interest extraction call within cost estimates.

This context already exists in the database. The `ai-write` endpoint already gathers a subset of this — we'd expand that pattern.

### Step 3: Interest Extraction (LLM Call #1)

Send the gathered context to the LLM with a prompt like:

```
You are analyzing conversation history with a professional contact.
Extract personal interests, hobbies, topics from small talk, or anything
they mentioned being passionate about outside of work.

Also extract professional interests that could be relevant:
their industry trends, company news angles, career interests.

For each interest found, provide:
- The interest/topic
- A direct quote or paraphrase from the conversation
- Which meeting/interaction it came from
- A confidence score (how clearly they expressed interest)
- A suggested search query (generic, no PII — never include the contact's name or company)

If no meetings/transcripts exist, derive interests from their profile:
industry trends, role-specific topics, company news, school/alumni angles.

Return as structured JSON. Do not fabricate interests.
```

Use OpenAI structured outputs (`response_format: { type: "json_schema", ... }`) to guarantee valid JSON.

**Output example:**
```json
{
  "interests": [
    {
      "topic": "credit card points and travel rewards",
      "evidence": "mentioned they just got the Amex Gold and are obsessed with maximizing points",
      "source": "Coffee chat - 2025-09-15",
      "confidence": 0.9,
      "search_query": "best credit card points strategies 2026"
    },
    {
      "topic": "marathon training",
      "evidence": "said they're training for their first marathon in April",
      "source": "Lunch meeting - 2025-10-02",
      "confidence": 0.85,
      "search_query": "first marathon training tips beginners"
    }
  ],
  "profile_based_fallbacks": [
    {
      "topic": "consulting industry trends",
      "evidence": "Works as Senior Consultant at Deloitte",
      "search_query": "consulting industry trends 2026"
    }
  ]
}
```

### Step 4: Search → Evaluate → Loop (The Core Loop)

This is the heart of the feature. The AI doesn't just grab the first article — it iterates until it finds something worth sharing.

```
┌─────────────────────────────────────────────┐
│  Pick highest-confidence interest            │
│              ↓                               │
│  Search Serper /news for that topic          │
│              ↓                               │
│  LLM evaluates top result:                   │
│  "Would this genuinely resonate?"            │
│              ↓                               │
│    YES → Draft email with this article       │
│    NO  → Try next search result              │
│              ↓                               │
│  Exhausted results? Try /search endpoint     │
│              ↓                               │
│  Still nothing? Try next interest topic      │
│              ↓                               │
│  No interests left? Use profile fallback     │
│              ↓                               │
│  Fallback also fails? Generic check-in draft │
└─────────────────────────────────────────────┘
```

**Search (Serper):**
- Start with `/news` endpoint — recent articles feel most natural to share
- Fall back to `/search` if news results are weak
- Search queries come from the LLM's suggestions (generic, no PII)
- Never include the contact's name, company, or other identifying info in queries

**Evaluate (LLM Call — repeated per candidate):**

```
You're helping someone reconnect with a professional contact.
The contact expressed interest in: {topic}
Evidence: "{evidence}"

Here is a candidate article to share:
- Title: {title}
- Source: {source}
- Snippet: {snippet}
- URL: {url}

Would sharing this article feel genuinely thoughtful and natural?

Evaluate:
1. Is this specifically relevant to what they mentioned, not just vaguely related?
2. Is the source credible and the content substantive?
3. Would a real person actually forward this to a friend?
4. Is this too generic (e.g., "10 tips for..." listicle) or too niche?

Return: { "verdict": "send" | "skip", "reason": "..." }
```

**Loop limits:**
- Max 3 articles evaluated per interest topic
- Max 3 interest topics tried
- Max 2 Serper calls per topic (news + web)
- Hard cap: ~8 total LLM evaluation calls per contact
- If nothing passes: fall back to a no-article check-in draft

### Step 5: Email Draft Generation (LLM Call — Final)

Generate the actual email, with tone adjusted to context:

```
Write a brief, warm follow-up email from {user_name} to {contact_name}.

Context:
- Contact: {name}, {role} at {company}, {industry}
- You last met: {time_ago} ({meeting_type})
- They mentioned: {interest with evidence}
- Article to share: {article_title} - {article_url}

Tone guidance:
- Infer appropriate formality from their role, industry, and your
  relationship context. A VP at Goldman gets a different tone than
  a college friend.
- Keep it to 3-5 sentences max
- Reference the specific thing they mentioned naturally
- Include the article link
- End with a brief personal touch
- Sign off as {user_first_name}
- Do NOT be overly enthusiastic or salesy
- Do NOT use phrases like "I stumbled upon" or "I came across"
  — say "I was reading this" or "saw this and thought of you"
```

**Example output:**
> Hey Sarah,
>
> I was reading [this piece on maximizing Amex points](https://example.com/article) and it immediately reminded me of our conversation — I remember you mentioning you'd just gotten the Gold card. Some solid tips in there if you haven't seen it.
>
> Hope things are going well at Deloitte!
>
> Best,
> Dawson

### Step 6: User Review & Send

The draft is stored and surfaced integrated into the dashboard.

---

## What the UI Could Look Like

### Dashboard Integration — Inside "Reach Out Today"

Rather than a separate section competing for attention, AI drafts are integrated into the existing "Reach Out Today" cards. When a contact is due for follow-up AND has an AI draft ready, their card gets an inline affordance:

```
┌─────────────────────────────────────────────────────┐
│  Reach Out Today                              5 contacts │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ [Avatar] Sarah Chen · Consulting · 3d overdue   │   │
│  │                                                  │   │
│  │  ┌ Draft Ready ────────────────────────────────┐│   │
│  │  │ "Hey Sarah, I was reading this piece on     ││   │
│  │  │ maximizing Amex points and it reminded..."  ││   │
│  │  │                                             ││   │
│  │  │ Based on: Coffee chat (Sep 15) · credit     ││   │
│  │  │ card points                                 ││   │
│  │  │                                             ││   │
│  │  │     [Review & Send]         [✕ Dismiss]     ││   │
│  │  └─────────────────────────────────────────────┘│   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ [Avatar] James Park · Finance · 12d overdue     │   │
│  │                                                  │   │
│  │  ┌ Draft Ready ────────────────────────────────┐│   │
│  │  │ "Hey James, saw this and thought of you..." ││   │
│  │  │                                             ││   │
│  │  │ Based on: Lunch (Oct 2) · marathon training ││   │
│  │  │                                             ││   │
│  │  │     [Review & Send]         [✕ Dismiss]     ││   │
│  │  └─────────────────────────────────────────────┘│   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ [Avatar] Mike Torres · Tech · 5d overdue        │   │
│  │  (no draft — no email on file)                   │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ [Avatar] Lisa Wang · Healthcare · 1d overdue    │   │
│  │  ⟳ Generating draft...                          │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

**Key UX details:**
- Contacts without drafts still appear normally (existing behavior preserved)
- Contacts with drafts in progress show a subtle loading spinner
- "Draft Ready" section is a collapsible inline card — not a separate dashboard section
- Only two actions on the card: "Review & Send" and dismiss (X icon)
- Cap at 3 draft generations per login to keep things fast
- Dismiss shows an undo toast (using existing toast system with action button)

### Review & Send Flow

Clicking "Review & Send" opens the **existing compose modal** pre-filled with the draft. No separate preview modal — the compose modal already handles everything.

At the top of the compose modal, a collapsible "AI Context" banner:

```
┌────────────────────────────────────────────────────────┐
│  Compose Email                                       ✕ │
│────────────────────────────────────────────────────────│
│                                                        │
│  ┌ AI Draft Context ─────────────────── [collapse ▾] ┐│
│  │ Based on: Coffee chat (Sep 15, 2025)              ││
│  │ Interest: "obsessed with maximizing credit card   ││
│  │ points" — mentioned getting the Amex Gold         ││
│  │ Article: "10 Ways to Max Your Amex Points"        ││
│  │          via NerdWallet                            ││
│  └───────────────────────────────────────────────────┘│
│                                                        │
│  To: sarah.chen@deloitte.com                           │
│  Subject: Thought of you                               │
│                                                        │
│  Send as: [New email ▾] / [Reply to: "Coffee next..."]│
│                                                        │
│  ┌─────────────────────────────────────────────────┐  │
│  │ Hey Sarah,                                      │  │
│  │                                                 │  │
│  │ I was reading this piece on maximizing Amex     │  │
│  │ points and it immediately reminded me of our    │  │
│  │ conversation — I remember you mentioning you'd  │  │
│  │ just gotten the Gold card. Some solid tips in   │  │
│  │ there if you haven't seen it.                   │  │
│  │                                                 │  │
│  │ Hope things are going well at Deloitte!         │  │
│  │                                                 │  │
│  │ Best,                                           │  │
│  │ Dawson                                          │  │
│  └─────────────────────────────────────────────────┘  │
│                                                        │
│              [Schedule Send]    [Send Now]              │
└────────────────────────────────────────────────────────┘
```

**New email vs reply to thread:**
- Auto-defaults to "Reply" if a thread with this contact exists within the last 60-90 days
- Auto-defaults to "New email" otherwise
- User can switch via a dropdown in the compose modal (consistent with how compose already handles thread context)
- The dropdown shows the last thread's subject for context

**After sending:**
- Existing `careervine:email-sent` event fires (dashboard refreshes)
- AI draft status updated to `sent` or `edited_and_sent`
- Contact's "last touch" updates, removing them from "Reach Out Today"

---

## Data Model

### New Table: `ai_follow_up_drafts`

```sql
CREATE TABLE ai_follow_up_drafts (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_id      INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,

  -- The draft email
  recipient_email VARCHAR,
  subject         VARCHAR NOT NULL,
  body_html       TEXT NOT NULL CHECK (length(body_html) < 50000),

  -- Thread reply option (null = new email only, populated = user can choose)
  reply_thread_id       VARCHAR,          -- Gmail thread ID of last conversation
  reply_thread_subject  VARCHAR,          -- Subject line shown in UI for context
  send_as_reply         BOOLEAN NOT NULL DEFAULT false,  -- user's choice (auto-defaulted)

  -- AI reasoning (transparency for the user)
  extracted_topic TEXT NOT NULL,        -- "credit card points"
  topic_evidence  TEXT NOT NULL,        -- "mentioned getting the Amex Gold"
  source_meeting_id INTEGER REFERENCES meetings(id),
  article_url     VARCHAR,
  article_title   VARCHAR,
  article_source  VARCHAR,             -- "NerdWallet"

  -- Status
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sent', 'dismissed', 'edited_and_sent')),

  -- Tracking
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ,
  dismissed_at    TIMESTAMPTZ
);

-- Partial unique index: only one pending draft per contact
CREATE UNIQUE INDEX idx_one_pending_draft_per_contact
  ON ai_follow_up_drafts (user_id, contact_id)
  WHERE status = 'pending';

-- Index for dashboard query (pending drafts per user)
CREATE INDEX idx_ai_follow_up_drafts_pending
  ON ai_follow_up_drafts (user_id, status)
  WHERE status = 'pending';

-- RLS
ALTER TABLE ai_follow_up_drafts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own drafts"
  ON ai_follow_up_drafts FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users can insert their own drafts"
  ON ai_follow_up_drafts FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update their own drafts"
  ON ai_follow_up_drafts FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete their own drafts"
  ON ai_follow_up_drafts FOR DELETE
  USING (user_id = auth.uid());

CREATE POLICY "Service role full access"
  ON ai_follow_up_drafts FOR ALL
  USING (auth.role() = 'service_role');
```

---

## API Routes

### `POST /api/gmail/ai-followups/generate`
- Called for a specific contact (or batch of due contacts)
- Verifies contact ownership before gathering any context
- Orchestrates the full pipeline: context → extract interests → search/evaluate loop → draft
- Sanitizes all Serper-returned content (DOMPurify server-side) before storing
- Validates article URLs are well-formed `https://` URLs
- Stores result in `ai_follow_up_drafts`
- Returns the draft for immediate display

### `GET /api/gmail/ai-followups/pending`
- Returns all pending drafts for the current user
- Dashboard calls this on load

### `PATCH /api/gmail/ai-followups/[id]`
- Update status (dismiss, mark sent)
- Update body/subject if user edits
- Update `send_as_reply` toggle

### `POST /api/gmail/ai-followups/[id]/send`
- Sends the email via shared Gmail send utility (extracted from existing `gmail/send` route)
- Handles both new email and reply-to-thread modes
- Updates draft status to `sent` or `edited_and_sent`
- Caches to `email_messages` with `matched_contact_id` (shared post-send logic)
- Creates an interaction record for the contact

---

## Cost Analysis (Per Follow-Up Draft)

| Step | API | Est. Cost |
|---|---|---|
| Interest extraction | OpenAI (structured output) | ~$0.002-0.01 (depends on transcript volume) |
| Web searches | Serper (avg 2 calls: news + web) | ~$0.008 |
| Article evaluations | OpenAI (avg 3-4 evaluations per draft) | ~$0.003-0.004 |
| Email draft | OpenAI | ~$0.001 |
| **Total per draft** | | **~$0.015-0.025** |

At 50 contacts with 6-month cadence = ~100 drafts/year = **~$1.50-2.50/year**. Negligible.

Note: Heavy users with long transcripts and many meetings per contact could see $0.03-0.05 per draft. At 200 drafts/year that's still under $10/year.

---

## Security & Privacy

### Sanitization
- All Serper-returned fields (URL, title, snippet) are sanitized with DOMPurify server-side before injecting into LLM prompts or storing in `body_html`
- Article URLs validated as well-formed `https://` — reject `javascript:`, `data:`, or non-HTTPS URLs
- Final `body_html` run through DOMPurify before storage

### Data Privacy
- Serper search queries are **generic and PII-free** — never include contact name, company, or identifying details. The LLM generates abstract search queries in Step 3.
- Meeting transcripts are sent to OpenAI for interest extraction. OpenAI API data is not used for training (per API terms), but this should be disclosed to the user.
- Feature requires explicit opt-in (user setting toggle) since it processes conversation data through external APIs.

### Ownership Verification
- Before gathering any context, the generate endpoint explicitly verifies `contact.user_id = authenticated_user.id`
- All downstream queries include `user_id` filter even when using service client

### Rate Limiting
- Max 3 draft generations per dashboard load (prevents runaway API costs)
- Per-user daily cap: 10 drafts/day
- Sequential processing (not parallel) to stay within API rate limits

---

## Edge Cases & Fallbacks

| Scenario | Handling |
|---|---|
| No personal interests found in any conversation | Use profile-based fallbacks (industry trends, company news, role-specific content) |
| No good article found after full search/evaluate loop | Draft without article — "Was thinking about our conversation about X, how's that going?" |
| Contact has no email on file | Skip draft, show contact normally in Reach Out Today without draft affordance |
| Contact has no meetings/transcripts/notes | Still generate — use profile data (role, company, industry, education) for industry/company news angle |
| Multiple strong interests found | Try highest confidence first, iterate through others if articles don't pass evaluation |
| Article URL is dead/paywalled | HTTP HEAD check before including — if non-200, try next result |
| User dismisses a draft | Show undo toast. After dismissal, don't regenerate for this contact for 7 days |
| User dismisses many drafts | Track dismiss rate; after threshold, surface a "tune your preferences" prompt |
| API failure mid-pipeline (OpenAI/Serper down) | Log failure, show subtle error state on contact card ("Couldn't generate draft — retry?") |
| Very long transcripts (10+ meetings) | Cap context at ~8K tokens, prioritize recent meetings, truncate older ones |

---

## Implementation Phases

### Phase 1: Core Pipeline + Dashboard Integration
- Interest extraction from all available contact context (transcripts, notes, profile)
- Serper integration (news + web search)
- Search → evaluate → loop until good article found
- Email draft generation with context-aware tone
- Store drafts in `ai_follow_up_drafts`
- Integrate draft cards into existing "Reach Out Today" section
- Open existing compose modal pre-filled with draft (+ AI context banner)
- Send via shared Gmail utility, dismiss with undo toast
- Generate on dashboard load for due contacts (cap at 3)

### Phase 2: Polish & Reliability
- HTTP HEAD validation on article URLs before including
- Loading skeletons in Reach Out Today while drafts generate
- "Retry" affordance for failed generations
- User setting to enable/disable AI follow-up drafts
- Track sent vs dismissed vs edited metrics

### Phase 3: Learning & Refinement
- Track which drafts get sent vs dismissed vs edited
- Use patterns to improve topic selection and article quality bar
- "More like this" / "Less like this" feedback buttons
- Adjust tone based on user's editing patterns

---

## Resolved Decisions

1. **Tone** — Adjust based on context. The LLM infers appropriate formality from the contact's industry, role, seniority, and the nature of past interactions.

2. **Interest caching** — Re-extract every time. Simpler architecture, negligible cost.

3. **Contacts with minimal data** — Still generate drafts. Profile data alone (education, job title, company, industry) is enough for a relevant industry/company news follow-up.

4. **New email vs reply to thread** — User chooses in the compose modal via dropdown. Auto-defaults to reply if a thread exists within 60-90 days, otherwise new email.

5. **Search API** — Serper. News endpoint first for timely articles, web search as fallback.

6. **When to generate** — On login/dashboard load, not via background cron. Avoids background infrastructure complexity and security concerns. Capped at 3 per load.

7. **Article quality** — The AI loops through search results and interest topics until it finds an article it judges would genuinely resonate. Not a one-shot grab — it iterates with clear evaluation criteria and fallback paths.

8. **Dashboard placement** — Integrated into existing "Reach Out Today" cards, not a separate section. Draft-ready contacts show an inline expandable card. Contacts without drafts display normally.

9. **Preview modal** — None. "Review & Send" opens the existing compose modal pre-filled with draft content. A collapsible "AI Draft Context" banner shows the reasoning at the top.
