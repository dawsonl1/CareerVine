# Onboarding Flow Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a 14-step guided onboarding experience that walks new users through CareerVine's core loop — connecting integrations, importing a contact, sending an AI email, logging a conversation, and extracting action items — using a draggable floating guide card overlay.

**Architecture:** A new `OnboardingProvider` context wraps the app and reads the user's onboarding state from a `user_onboarding` database table. A `<OnboardingGuide />` component renders a draggable floating card with step-specific content. Steps advance via manual confirmation buttons or automatic detection of completed actions. A seed contact (Dawson Pitcher) is created on signup, with simulated email replies and a dynamically-created calendar event during the flow.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, Supabase (Postgres + RLS), Google Calendar API, Gmail API

**Spec:** `docs/superpowers/specs/2026-03-25-onboarding-flow-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `supabase/migrations/20260326000000_onboarding_schema.sql` | Database migration: `user_onboarding` table + `is_simulated` column on `email_messages` |
| `careervine/src/app/api/onboarding/setup/route.ts` | POST: Seed Dawson contact + onboarding row on signup |
| `careervine/src/app/api/onboarding/advance/route.ts` | POST: Advance onboarding step + trigger side effects (simulated reply, meeting insertion) |
| `careervine/src/app/api/onboarding/status/route.ts` | GET: Fetch current onboarding state |
| `careervine/src/app/api/onboarding/skip/route.ts` | POST: Skip/complete onboarding + cleanup |
| `careervine/src/components/onboarding/onboarding-provider.tsx` | React context: manages onboarding state, step progression, advance/skip functions |
| `careervine/src/components/onboarding/onboarding-guide.tsx` | The draggable floating card UI component |
| `careervine/src/components/onboarding/onboarding-steps.ts` | Step configuration array (all 14 steps with titles, descriptions, CTAs, targets) |
| `careervine/src/components/onboarding/onboarding-highlight.tsx` | CSS overlay + pulse highlight for target elements |
| `careervine/src/components/onboarding/transcript-content.ts` | The sample transcript template with `{firstName}` placeholder |
| `careervine/src/__tests__/onboarding/onboarding-provider.test.tsx` | Tests for onboarding context |
| `careervine/src/__tests__/onboarding/onboarding-guide.test.tsx` | Tests for guide card UI |
| `careervine/src/__tests__/onboarding/onboarding-steps.test.ts` | Tests for step configuration |
| `careervine/src/__tests__/api/onboarding-setup.test.ts` | Tests for seed API |
| `careervine/src/__tests__/api/onboarding-advance.test.ts` | Tests for advance API |

### Modified Files
| File | Changes |
|------|---------|
| `careervine/src/app/layout.tsx` | Add `OnboardingProvider` to provider stack |
| `careervine/src/components/auth-provider.tsx` | Call onboarding setup API after successful signup |
| `careervine/src/app/api/gmail/send/route.ts` | Detect sends to `dawson@careervine.app`, trigger simulated reply |
| `careervine/src/app/page.tsx` | Add `data-onboarding-target` attributes to key elements |
| `careervine/src/components/home/unified-action-list.tsx` | Add `data-onboarding-target="intro-button-dawson"` to Dawson's intro button |
| `careervine/src/components/navigation.tsx` | Add `data-onboarding-target` attributes to nav items (inbox, home) |
| `careervine/src/lib/database.types.ts` | Add `user_onboarding` table types + `is_simulated` field on `email_messages` |

---

## Task 1: Database Migration

**Files:**
- Create: `supabase/migrations/20260326000000_onboarding_schema.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- Create onboarding tracking table
CREATE TABLE user_onboarding (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  current_step TEXT NOT NULL DEFAULT 'connect_gmail',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  skipped_apollo BOOLEAN DEFAULT false,
  onboarding_calendar_event_id TEXT
);

-- Enable RLS
ALTER TABLE user_onboarding ENABLE ROW LEVEL SECURITY;

-- Users can only read/update their own onboarding row
CREATE POLICY "Users can view own onboarding" ON user_onboarding
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can update own onboarding" ON user_onboarding
  FOR UPDATE USING (auth.uid() = user_id);

-- Service role can insert (used during signup seed)
CREATE POLICY "Service can insert onboarding" ON user_onboarding
  FOR INSERT WITH CHECK (true);

-- Add is_simulated flag to email_messages for fake replies
ALTER TABLE email_messages ADD COLUMN is_simulated BOOLEAN DEFAULT false;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260326000000_onboarding_schema.sql
git commit -m "feat: add user_onboarding table and is_simulated email column"
```

---

## Task 2: Update Database Types

**Files:**
- Modify: `careervine/src/lib/database.types.ts`

- [ ] **Step 1: Add `user_onboarding` table types**

Add to the `Tables` interface in `database.types.ts`:

```typescript
user_onboarding: {
  Row: {
    user_id: string;
    version: number;
    current_step: string;
    started_at: string;
    completed_at: string | null;
    skipped_apollo: boolean;
    onboarding_calendar_event_id: string | null;
  };
  Insert: {
    user_id: string;
    version?: number;
    current_step?: string;
    started_at?: string;
    completed_at?: string | null;
    skipped_apollo?: boolean;
    onboarding_calendar_event_id?: string | null;
  };
  Update: Partial<Database["public"]["Tables"]["user_onboarding"]["Insert"]>;
};
```

- [ ] **Step 2: Add `is_simulated` to `email_messages` Row and Insert types**

Add `is_simulated: boolean;` to `email_messages.Row` and `is_simulated?: boolean;` to `email_messages.Insert`.

- [ ] **Step 3: Commit**

```bash
git add careervine/src/lib/database.types.ts
git commit -m "feat: add user_onboarding and is_simulated types"
```

---

## Task 3: Onboarding Step Configuration

**Files:**
- Create: `careervine/src/components/onboarding/onboarding-steps.ts`
- Create: `careervine/src/components/onboarding/transcript-content.ts`
- Create: `careervine/src/__tests__/onboarding/onboarding-steps.test.ts`

- [ ] **Step 1: Write the test for step configuration**

```typescript
// careervine/src/__tests__/onboarding/onboarding-steps.test.ts
import { describe, it, expect } from "vitest";
import { ONBOARDING_STEPS, getStepIndex, getStepById } from "@/components/onboarding/onboarding-steps";

describe("onboarding steps", () => {
  it("has exactly 14 steps", () => {
    expect(ONBOARDING_STEPS).toHaveLength(14);
  });

  it("each step has required fields", () => {
    for (const step of ONBOARDING_STEPS) {
      expect(step.id).toBeTruthy();
      expect(step.title).toBeTruthy();
      expect(step.description).toBeTruthy();
      expect(step.page).toBeTruthy();
    }
  });

  it("step IDs are unique", () => {
    const ids = ONBOARDING_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("getStepIndex returns correct index", () => {
    expect(getStepIndex("connect_gmail")).toBe(0);
    expect(getStepIndex("wispr_recommendation")).toBe(13);
  });

  it("getStepById returns correct step", () => {
    const step = getStepById("install_cv_extension");
    expect(step?.title).toContain("Chrome Extension");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd careervine && npx vitest run src/__tests__/onboarding/onboarding-steps.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: Write the transcript content template**

```typescript
// careervine/src/components/onboarding/transcript-content.ts

export function getOnboardingTranscript(firstName: string): string {
  return `Dawson: Hey, thanks so much for hopping on this call. So you're studying Information Systems, right? Tell me a little about where you're at in your program.

${firstName}: Yeah, I'm a junior at the University of Georgia. I'm majoring in MIS and I've been trying to figure out what direction I want to go after graduation. I know IS is broad, so I've been doing a lot of these calls to learn about different paths.

Dawson: That's really smart. Honestly, most people don't start networking until they're desperate for a job, so you're way ahead. What's caught your eye so far?

${firstName}: I think I'm most interested in the consulting side of things. I like the idea of solving problems for different companies rather than being stuck at one. But I honestly don't know that much about what the day-to-day looks like.

Dawson: Yeah, that's a great question. So I'm a Senior Business Analyst at Deloitte, and I've been here about six years now. The day-to-day really depends on the project. Right now I'm on an ERP implementation for a healthcare client, so my days are a lot of requirements gathering, stakeholder interviews, process mapping — that kind of thing.

${firstName}: That sounds really interesting. What did your path look like getting there? Did you go straight into consulting out of school?

Dawson: Not exactly. I actually started at a mid-size company doing IT support, which I know sounds unglamorous, but it taught me so much about how businesses actually use technology. After about a year and a half I moved into a business analyst role at the same company, and then Deloitte recruited me from there. So it wasn't a straight line, but every step made sense in hindsight.

${firstName}: That's really encouraging to hear. A lot of people make it sound like you have to land a Big Four internship or you're behind.

Dawson: Not at all. I mean, internships help for sure, but what really matters is that you can show you understand both the business side and the technical side. That's the sweet spot for IS people. Can you talk to a CIO and also understand what the developers are building? That's the skill.

${firstName}: That makes a lot of sense. So what skills would you say I should be focusing on right now to be competitive for a role like yours?

Dawson: SQL is a must — you'd be surprised how many analysts can't write a decent query. Get comfortable with data visualization too, Tableau or Power BI. And honestly, the soft skills matter just as much. Learn to run a meeting, write a clear email, present to people who don't care about technology. Those things separate the good analysts from the great ones.

${firstName}: I've been learning SQL in my database class actually, but I haven't touched Tableau yet. Any recommendations on how to get started?

Dawson: Tableau has a free version called Tableau Public. Just download it, grab a public dataset, and build something. Put it on your LinkedIn. Hiring managers love seeing that. Actually, my friend Sarah Chen runs the analytics practice at our Atlanta office — she literally teaches a Tableau workshop for new hires. I could introduce you to her if you want. She's great with students.

${firstName}: Oh wow, that would be incredible. I'd really appreciate that.

Dawson: Yeah, send me your resume and I'll shoot her an email. Just make sure your LinkedIn is updated too — she's going to look at it.

${firstName}: Absolutely, I'll send my resume over tonight and clean up my LinkedIn this weekend. Should I connect with her on LinkedIn too, or wait for your intro first?

Dawson: Wait for my intro — I'll CC you on the email so it's a warm handoff. Then you can connect with her right after and reference the email. That's always the smoothest way to do it.

${firstName}: Got it. That's a really good tip actually. I've been cold-connecting with people and the response rate is pretty low.

Dawson: Yeah, warm intros are everything. That's literally why networking matters — it's not about collecting contacts, it's about building a chain of trust. Someone vouches for you, that person vouches for you to the next person, and so on.

${firstName}: That's a great way to think about it. One more question — do you have any book or resource recommendations? I want to make sure I'm learning the right things outside of class.

Dawson: Definitely read "The McKinsey Way" by Ethan Rasiel. It's technically about management consulting, but the frameworks for structured problem-solving apply to any analyst role. It completely changed how I approach client problems.

${firstName}: I'll check that out. Is that something I could find at the library or should I just buy it?

Dawson: It's on Amazon for like fifteen bucks. Totally worth it. And honestly, if you want to go deep on the technical side, look into getting a Tableau Desktop Specialist certification. It's not hard if you practice, and it looks great on a resume for entry-level roles.

${firstName}: That's awesome advice. I'm going to look into both of those this week. Dawson, this has been so helpful. I really appreciate you sharing all of this.

Dawson: Absolutely. You're asking the right questions, which tells me you're going to do well. Let me get that intro to Sarah set up for you this week, and don't hesitate to reach out if you have more questions down the road.

${firstName}: Will do. Thanks again, Dawson. Have a great rest of your day.

Dawson: You too! Good luck with everything.`;
}
```

- [ ] **Step 4: Write the step configuration**

```typescript
// careervine/src/components/onboarding/onboarding-steps.ts

export interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  page: string; // expected route
  highlightTarget?: string; // data-onboarding-target value
  primaryAction?: {
    label: string;
    href?: string; // external link (opens new tab)
    action?: string; // internal action identifier
  };
  secondaryAction?: {
    label: string;
    action: string;
  };
  skippable: boolean;
  advanceOn: "manual" | "automatic"; // manual = user clicks button, automatic = detected by app
  expandable?: boolean; // step 11 — card grows to show transcript
}

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: "connect_gmail",
    title: "Connect your Gmail",
    description:
      "Let's connect your Gmail so you can send and read emails right from CareerVine.",
    page: "/",
    primaryAction: {
      label: "Connect Gmail",
      action: "oauth_gmail",
    },
    skippable: false,
    advanceOn: "automatic",
  },
  {
    id: "connect_calendar",
    title: "Connect Google Calendar",
    description:
      "Now let's connect your Google Calendar. CareerVine will sync your events and help you prepare for meetings.",
    page: "/",
    primaryAction: {
      label: "Connect Calendar",
      action: "oauth_calendar",
    },
    skippable: false,
    advanceOn: "automatic",
  },
  {
    id: "install_cv_extension",
    title: "Install the CareerVine Chrome Extension",
    description:
      "This extension lets you import contacts directly from LinkedIn profiles with one click.",
    page: "/",
    primaryAction: {
      label: "Install Extension",
      href: "https://chromewebstore.google.com/detail/careervine-linkedin-integ/kckdmkjjfcnjlhilgdgfggpgodlmbacd",
    },
    secondaryAction: {
      label: "I've installed it",
      action: "confirm",
    },
    skippable: false,
    advanceOn: "manual",
  },
  {
    id: "install_apollo_extension",
    title: "Install Apollo.io (Recommended)",
    description:
      "Apollo.io finds contact emails so you can enrich your LinkedIn imports. This is optional but highly recommended.",
    page: "/",
    primaryAction: {
      label: "Install Apollo.io",
      href: "https://chromewebstore.google.com/detail/apolloio-free-b2b-phone-n/alhgpfoeiimagjlnfekdhkjlkiomcapa",
    },
    secondaryAction: {
      label: "Skip for now",
      action: "skip",
    },
    skippable: true,
    advanceOn: "manual",
  },
  {
    id: "import_linkedin_contact",
    title: "Import a Contact from LinkedIn",
    description:
      "Head to LinkedIn, find someone in your network, and use the CareerVine extension to save them. If you have Apollo installed, grab their email too!",
    page: "/",
    secondaryAction: {
      label: "I've imported a contact",
      action: "confirm",
    },
    skippable: false,
    advanceOn: "manual",
  },
  {
    id: "click_intro_button",
    title: "Send Your First AI Email",
    description:
      "Nice work! You could email your new contact now, but let's practice first. See Dawson Pitcher in your action list? Click the intro button to draft your first AI-powered email.",
    page: "/",
    highlightTarget: "intro-button-dawson",
    skippable: false,
    advanceOn: "automatic",
  },
  {
    id: "compose_send_email",
    title: "Compose & Send with AI",
    description:
      "Use the AI composer to draft your intro email to Dawson. Set up follow-up emails too — CareerVine will automatically send them if Dawson doesn't reply.",
    page: "/",
    skippable: false,
    advanceOn: "automatic",
  },
  {
    id: "read_reply",
    title: "Check Your Inbox",
    description:
      "Dawson replied! Head to your Inbox to read it. Notice that your follow-up emails have been automatically cancelled since you got a reply.",
    page: "/inbox",
    highlightTarget: "nav-inbox",
    skippable: false,
    advanceOn: "automatic",
  },
  {
    id: "view_meeting",
    title: "See Your Meeting",
    description:
      "Head back to your home page. We've added a networking chat with Dawson to your Google Calendar — check your schedule to see it.",
    page: "/",
    highlightTarget: "nav-home",
    skippable: false,
    advanceOn: "automatic",
  },
  {
    id: "click_meeting",
    title: "Open the Meeting",
    description:
      "Click on the meeting with Dawson to add notes from your conversation.",
    page: "/",
    highlightTarget: "onboarding-meeting",
    skippable: false,
    advanceOn: "automatic",
  },
  {
    id: "paste_transcript",
    title: "Paste the Transcript",
    description:
      "Here's a transcript from your call with Dawson. Copy it and paste it into the transcript field.",
    page: "/",
    skippable: false,
    advanceOn: "automatic",
    expandable: true,
  },
  {
    id: "extract_actions",
    title: "Extract Action Items",
    description:
      "Now hit 'Analyze' to let AI extract the action items from your conversation. This is the magic.",
    page: "/",
    highlightTarget: "extract-actions-button",
    skippable: false,
    advanceOn: "automatic",
  },
  {
    id: "view_dashboard_actions",
    title: "Your Command Center",
    description:
      "Head back to your dashboard. Your action items are waiting for you — this is your command center.",
    page: "/",
    highlightTarget: "nav-home",
    skippable: false,
    advanceOn: "automatic",
  },
  {
    id: "wispr_recommendation",
    title: "One More Thing",
    description:
      "Check out Wispr Flow — it's a voice dictation app that makes capturing meeting notes effortless. Full disclosure: this is my referral link. You'll get an extra free month, and I'll get one too.",
    page: "/",
    primaryAction: {
      label: "Check it out",
      href: "https://wisprflow.ai/r?DAWSON59",
    },
    secondaryAction: {
      label: "I'm good, let's go",
      action: "complete",
    },
    skippable: true,
    advanceOn: "manual",
  },
];

export function getStepIndex(stepId: string): number {
  return ONBOARDING_STEPS.findIndex((s) => s.id === stepId);
}

export function getStepById(stepId: string): OnboardingStep | undefined {
  return ONBOARDING_STEPS.find((s) => s.id === stepId);
}

export function getNextStep(currentStepId: string): OnboardingStep | null {
  const idx = getStepIndex(currentStepId);
  if (idx === -1 || idx >= ONBOARDING_STEPS.length - 1) return null;
  return ONBOARDING_STEPS[idx + 1];
}

export function getProgress(currentStepId: string): number {
  const idx = getStepIndex(currentStepId);
  if (idx === -1) return 0;
  return Math.round((idx / ONBOARDING_STEPS.length) * 100);
}
```

- [ ] **Step 5: Run tests**

```bash
cd careervine && npx vitest run src/__tests__/onboarding/onboarding-steps.test.ts
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add careervine/src/components/onboarding/onboarding-steps.ts careervine/src/components/onboarding/transcript-content.ts careervine/src/__tests__/onboarding/onboarding-steps.test.ts
git commit -m "feat: add onboarding step configuration and transcript template"
```

---

## Task 4: Onboarding API Routes

**Files:**
- Create: `careervine/src/app/api/onboarding/setup/route.ts`
- Create: `careervine/src/app/api/onboarding/advance/route.ts`
- Create: `careervine/src/app/api/onboarding/status/route.ts`
- Create: `careervine/src/app/api/onboarding/skip/route.ts`

- [ ] **Step 1: Write the setup route (seed Dawson contact + onboarding row)**

```typescript
// careervine/src/app/api/onboarding/setup/route.ts
import { NextResponse } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { createRouteHandlerClient } from "@supabase/auth-helpers-nextjs";
import { cookies } from "next/headers";

const DAWSON_CONTACT = {
  first_name: "Dawson",
  last_name: "Pitcher",
  company: "Deloitte",
  title: "Senior Business Analyst",
};

const DAWSON_EMAIL = "dawson@careervine.app";

export async function POST() {
  const supabase = createRouteHandlerClient({ cookies });
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const service = createSupabaseServiceClient();

  // Check if onboarding already exists (idempotent)
  const { data: existing } = await service
    .from("user_onboarding")
    .select("user_id")
    .eq("user_id", user.id)
    .single();

  if (existing) {
    return NextResponse.json({ status: "already_setup" });
  }

  // Create Dawson contact
  const { data: contact, error: contactError } = await service
    .from("contacts")
    .insert({
      user_id: user.id,
      first_name: DAWSON_CONTACT.first_name,
      last_name: DAWSON_CONTACT.last_name,
      company: DAWSON_CONTACT.company,
      title: DAWSON_CONTACT.title,
    })
    .select("id")
    .single();

  if (contactError) {
    console.error("Failed to create Dawson contact:", contactError);
    return NextResponse.json({ error: "Failed to setup" }, { status: 500 });
  }

  // Add Dawson's email
  await service.from("contact_emails").insert({
    contact_id: contact.id,
    email: DAWSON_EMAIL,
    is_primary: true,
  });

  // Create onboarding row
  const { error: onboardingError } = await service
    .from("user_onboarding")
    .insert({
      user_id: user.id,
      version: 1,
      current_step: "connect_gmail",
    });

  if (onboardingError) {
    console.error("Failed to create onboarding row:", onboardingError);
    return NextResponse.json({ error: "Failed to setup" }, { status: 500 });
  }

  return NextResponse.json({ status: "setup_complete", dawsonContactId: contact.id });
}
```

- [ ] **Step 2: Write the status route**

```typescript
// careervine/src/app/api/onboarding/status/route.ts
import { NextResponse } from "next/server";
import { createRouteHandlerClient } from "@supabase/auth-helpers-nextjs";
import { cookies } from "next/headers";

export async function GET() {
  const supabase = createRouteHandlerClient({ cookies });
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data } = await supabase
    .from("user_onboarding")
    .select("*")
    .eq("user_id", user.id)
    .single();

  if (!data) {
    return NextResponse.json({ onboarding: null });
  }

  return NextResponse.json({ onboarding: data });
}
```

- [ ] **Step 3: Write the advance route**

This route advances the onboarding step and triggers side effects for specific steps.

```typescript
// careervine/src/app/api/onboarding/advance/route.ts
import { NextResponse } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { createRouteHandlerClient } from "@supabase/auth-helpers-nextjs";
import { cookies } from "next/headers";
import { getNextStep } from "@/components/onboarding/onboarding-steps";
import { createCalendarEvent } from "@/lib/calendar";

export async function POST(req: Request) {
  const supabase = createRouteHandlerClient({ cookies });
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { currentStep, skippedApollo } = await req.json();
  const service = createSupabaseServiceClient();

  const nextStep = getNextStep(currentStep);

  // Handle side effects for specific step transitions
  if (currentStep === "read_reply" && nextStep?.id === "view_meeting") {
    // Create the fake meeting in Google Calendar
    try {
      const now = new Date();
      const endTime = new Date(now.getTime() - 30 * 60 * 1000); // 30 min ago
      const startTime = new Date(endTime.getTime() - 45 * 60 * 1000); // 45 min before end

      const { googleEventId } = await createCalendarEvent(user.id, {
        summary: "Networking Chat with Dawson Pitcher",
        description: "Informational interview — CareerVine onboarding",
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        conferenceType: "none",
      });

      // Find the Dawson contact
      const { data: dawsonContact } = await service
        .from("contact_emails")
        .select("contact_id")
        .eq("email", "dawson@careervine.app")
        .limit(1)
        .single();

      // Create CareerVine meeting record
      const { data: meeting } = await service
        .from("meetings")
        .insert({
          user_id: user.id,
          meeting_date: startTime.toISOString(),
          meeting_type: "video",
          title: "Networking Chat with Dawson Pitcher",
          calendar_event_id: googleEventId,
        })
        .select("id")
        .single();

      // Link meeting to Dawson contact
      if (meeting && dawsonContact) {
        await service.from("meeting_contacts").insert({
          meeting_id: meeting.id,
          contact_id: dawsonContact.contact_id,
        });
      }

      // Store calendar event ID for cleanup
      await service
        .from("user_onboarding")
        .update({ onboarding_calendar_event_id: googleEventId })
        .eq("user_id", user.id);
    } catch (err) {
      console.error("Failed to create onboarding meeting:", err);
      // Don't block onboarding if this fails
    }
  }

  // Update step
  const updates: Record<string, unknown> = {
    current_step: nextStep ? nextStep.id : "complete",
  };

  if (skippedApollo) {
    updates.skipped_apollo = true;
  }

  if (!nextStep) {
    updates.completed_at = new Date().toISOString();
  }

  await service
    .from("user_onboarding")
    .update(updates)
    .eq("user_id", user.id);

  return NextResponse.json({
    nextStep: nextStep?.id || "complete",
    completed: !nextStep,
  });
}
```

- [ ] **Step 4: Write the skip/complete route**

```typescript
// careervine/src/app/api/onboarding/skip/route.ts
import { NextResponse } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { createRouteHandlerClient } from "@supabase/auth-helpers-nextjs";
import { cookies } from "next/headers";
import { deleteCalendarEvent } from "@/lib/calendar";

export async function POST() {
  const supabase = createRouteHandlerClient({ cookies });
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const service = createSupabaseServiceClient();

  // Get onboarding row to check for calendar event cleanup
  const { data: onboarding } = await service
    .from("user_onboarding")
    .select("onboarding_calendar_event_id")
    .eq("user_id", user.id)
    .single();

  // Clean up Google Calendar event if it exists
  if (onboarding?.onboarding_calendar_event_id) {
    try {
      await deleteCalendarEvent(user.id, onboarding.onboarding_calendar_event_id);
    } catch (err) {
      console.error("Failed to delete onboarding calendar event:", err);
    }
  }

  // Mark complete
  await service
    .from("user_onboarding")
    .update({
      current_step: "complete",
      completed_at: new Date().toISOString(),
    })
    .eq("user_id", user.id);

  return NextResponse.json({ status: "skipped" });
}
```

- [ ] **Step 5: Add `deleteCalendarEvent` to `lib/calendar.ts` if it doesn't exist**

Check `careervine/src/lib/calendar.ts` for an existing delete function. If not present, add:

```typescript
export async function deleteCalendarEvent(
  userId: string,
  googleEventId: string,
  calendarId: string = "primary"
) {
  const calendar = await getCalendarClient(userId);
  await calendar.events.delete({ calendarId, eventId: googleEventId });
}
```

- [ ] **Step 6: Commit**

```bash
git add careervine/src/app/api/onboarding/ careervine/src/lib/calendar.ts
git commit -m "feat: add onboarding API routes (setup, status, advance, skip)"
```

---

## Task 5: Simulated Email Reply Logic

**Files:**
- Modify: `careervine/src/app/api/gmail/send/route.ts`

- [ ] **Step 1: Add dawson@careervine.app detection after email send**

In `careervine/src/app/api/gmail/send/route.ts`, after the email is sent and the `email_messages` row is upserted, add logic to detect sends to `dawson@careervine.app` and insert a simulated reply.

Add this after the existing `email_messages` upsert (around line 57):

```typescript
// Check if this is a send to dawson@careervine.app for onboarding
if (toAddr === "dawson@careervine.app") {
  // Check if this is the first email to Dawson from this user
  const { data: onboarding } = await service
    .from("user_onboarding")
    .select("current_step")
    .eq("user_id", user.id)
    .single();

  if (onboarding && onboarding.current_step === "compose_send_email") {
    // Insert simulated reply after a short delay
    const replyDate = new Date(Date.now() + 5000); // 5 seconds from now
    await service.from("email_messages").insert({
      user_id: user.id,
      gmail_message_id: `simulated-reply-${Date.now()}`,
      thread_id: result.threadId || null,
      subject: `Re: ${subject}`,
      snippet:
        "Hey! Thanks for reaching out — welcome to CareerVine. I built this to help people like you stay on top of their network.",
      from_address: "dawson@careervine.app",
      to_addresses: [conn?.gmail_address?.toLowerCase() || ""],
      date: replyDate.toISOString(),
      label_ids: ["INBOX"],
      is_read: false,
      direction: "inbound",
      matched_contact_id: matchedContactId,
      is_simulated: true,
    });

    // Cancel any follow-up sequences for this thread
    if (result.threadId) {
      await service
        .from("email_follow_up_messages")
        .update({ status: "cancelled" })
        .eq("status", "pending")
        .in(
          "follow_up_id",
          service
            .from("email_follow_ups")
            .select("id")
            .eq("user_id", user.id)
            .eq("thread_id", result.threadId)
        );
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add careervine/src/app/api/gmail/send/route.ts
git commit -m "feat: add simulated reply for dawson@careervine.app sends"
```

---

## Task 6: Onboarding Context Provider

**Files:**
- Create: `careervine/src/components/onboarding/onboarding-provider.tsx`
- Create: `careervine/src/__tests__/onboarding/onboarding-provider.test.tsx`

- [ ] **Step 1: Write tests for the provider**

```typescript
// careervine/src/__tests__/onboarding/onboarding-provider.test.tsx
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { OnboardingProvider, useOnboarding } from "@/components/onboarding/onboarding-provider";

// Mock fetch
global.fetch = vi.fn();

function wrapper({ children }: { children: React.ReactNode }) {
  return <OnboardingProvider>{children}</OnboardingProvider>;
}

describe("useOnboarding", () => {
  it("provides default state when no onboarding data", () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ onboarding: null }),
    });

    const { result } = renderHook(() => useOnboarding(), { wrapper });
    expect(result.current.isActive).toBe(false);
    expect(result.current.currentStep).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd careervine && npx vitest run src/__tests__/onboarding/onboarding-provider.test.tsx
```
Expected: FAIL — module not found

- [ ] **Step 3: Write the provider**

```typescript
// careervine/src/components/onboarding/onboarding-provider.tsx
"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { useAuth } from "@/components/auth-provider";
import {
  ONBOARDING_STEPS,
  getStepById,
  getStepIndex,
  getProgress,
  type OnboardingStep,
} from "./onboarding-steps";

interface OnboardingState {
  isActive: boolean;
  currentStep: OnboardingStep | null;
  currentStepId: string | null;
  progress: number;
  version: number | null;
  loading: boolean;
  advance: (skippedApollo?: boolean) => Promise<void>;
  skip: () => Promise<void>;
  refreshStatus: () => Promise<void>;
}

const OnboardingContext = createContext<OnboardingState | undefined>(undefined);

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [currentStepId, setCurrentStepId] = useState<string | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    if (!user) {
      setLoading(false);
      return;
    }
    try {
      const res = await fetch("/api/onboarding/status");
      const { onboarding } = await res.json();
      if (onboarding && !onboarding.completed_at) {
        setCurrentStepId(onboarding.current_step);
        setVersion(onboarding.version);
      } else {
        setCurrentStepId(null);
      }
    } catch {
      setCurrentStepId(null);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const advance = useCallback(
    async (skippedApollo?: boolean) => {
      if (!currentStepId) return;
      try {
        const res = await fetch("/api/onboarding/advance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            currentStep: currentStepId,
            skippedApollo,
          }),
        });
        const { nextStep, completed } = await res.json();
        if (completed) {
          setCurrentStepId(null);
        } else {
          setCurrentStepId(nextStep);
        }
      } catch (err) {
        console.error("Failed to advance onboarding:", err);
      }
    },
    [currentStepId]
  );

  const skip = useCallback(async () => {
    try {
      await fetch("/api/onboarding/skip", { method: "POST" });
      setCurrentStepId(null);
    } catch (err) {
      console.error("Failed to skip onboarding:", err);
    }
  }, []);

  const isActive = !loading && currentStepId !== null && currentStepId !== "complete";
  const currentStep = currentStepId ? getStepById(currentStepId) ?? null : null;
  const progress = currentStepId ? getProgress(currentStepId) : 0;

  return (
    <OnboardingContext.Provider
      value={{
        isActive,
        currentStep,
        currentStepId,
        progress,
        version,
        loading,
        advance,
        skip,
        refreshStatus: fetchStatus,
      }}
    >
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboarding() {
  const ctx = useContext(OnboardingContext);
  if (!ctx) {
    throw new Error("useOnboarding must be used within OnboardingProvider");
  }
  return ctx;
}
```

- [ ] **Step 4: Run tests**

```bash
cd careervine && npx vitest run src/__tests__/onboarding/onboarding-provider.test.tsx
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add careervine/src/components/onboarding/onboarding-provider.tsx careervine/src/__tests__/onboarding/onboarding-provider.test.tsx
git commit -m "feat: add onboarding context provider with state management"
```

---

## Task 7: Onboarding Guide UI Component

**Files:**
- Create: `careervine/src/components/onboarding/onboarding-guide.tsx`
- Create: `careervine/src/components/onboarding/onboarding-highlight.tsx`
- Create: `careervine/src/__tests__/onboarding/onboarding-guide.test.tsx`

- [ ] **Step 1: Write tests for the guide component**

```typescript
// careervine/src/__tests__/onboarding/onboarding-guide.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OnboardingGuide } from "@/components/onboarding/onboarding-guide";

// Mock the onboarding context
vi.mock("@/components/onboarding/onboarding-provider", () => ({
  useOnboarding: () => ({
    isActive: true,
    currentStep: {
      id: "connect_gmail",
      title: "Connect your Gmail",
      description: "Let's connect your Gmail.",
      page: "/",
      primaryAction: { label: "Connect Gmail", action: "oauth_gmail" },
      skippable: false,
      advanceOn: "automatic",
    },
    currentStepId: "connect_gmail",
    progress: 0,
    advance: vi.fn(),
    skip: vi.fn(),
  }),
}));

// Mock useAuth
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    user: { user_metadata: { first_name: "Test" } },
  }),
}));

describe("OnboardingGuide", () => {
  it("renders the current step title and description", () => {
    render(<OnboardingGuide />);
    expect(screen.getByText("Connect your Gmail")).toBeTruthy();
    expect(screen.getByText("Let's connect your Gmail.")).toBeTruthy();
  });

  it("shows progress indicator", () => {
    render(<OnboardingGuide />);
    expect(screen.getByText("1/14")).toBeTruthy();
  });

  it("renders skip tutorial link", () => {
    render(<OnboardingGuide />);
    expect(screen.getByText("Skip tutorial")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd careervine && npx vitest run src/__tests__/onboarding/onboarding-guide.test.tsx
```
Expected: FAIL — module not found

- [ ] **Step 3: Write the highlight component**

```typescript
// careervine/src/components/onboarding/onboarding-highlight.tsx
"use client";

import { useEffect } from "react";
import { useOnboarding } from "./onboarding-provider";

export function OnboardingHighlight() {
  const { currentStep, isActive } = useOnboarding();

  useEffect(() => {
    if (!isActive || !currentStep?.highlightTarget) return;

    const target = document.querySelector(
      `[data-onboarding-target="${currentStep.highlightTarget}"]`
    );
    if (!target) return;

    target.classList.add("onboarding-highlight");

    return () => {
      target.classList.remove("onboarding-highlight");
    };
  }, [isActive, currentStep]);

  if (!isActive || !currentStep?.highlightTarget) return null;

  // Semi-transparent overlay
  return (
    <div
      className="fixed inset-0 bg-black/30 z-[998] pointer-events-none transition-opacity duration-300"
      aria-hidden
    />
  );
}
```

Also add these CSS classes to the global styles (in `careervine/src/app/globals.css` or equivalent):

```css
.onboarding-highlight {
  position: relative;
  z-index: 999;
  box-shadow: 0 0 0 4px rgba(76, 175, 80, 0.5);
  border-radius: 8px;
  animation: onboarding-pulse 2s ease-in-out infinite;
}

@keyframes onboarding-pulse {
  0%, 100% { box-shadow: 0 0 0 4px rgba(76, 175, 80, 0.3); }
  50% { box-shadow: 0 0 0 8px rgba(76, 175, 80, 0.1); }
}
```

- [ ] **Step 4: Write the guide component**

```typescript
// careervine/src/components/onboarding/onboarding-guide.tsx
"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useOnboarding } from "./onboarding-provider";
import { useAuth } from "@/components/auth-provider";
import { getStepIndex, ONBOARDING_STEPS } from "./onboarding-steps";
import { getOnboardingTranscript } from "./transcript-content";
import { GripHorizontal, X, Copy, Check, ExternalLink } from "lucide-react";

export function OnboardingGuide() {
  const { isActive, currentStep, currentStepId, progress, advance, skip } =
    useOnboarding();
  const { user } = useAuth();
  const [position, setPosition] = useState({ x: -1, y: -1 }); // -1 = use default
  const [isDragging, setIsDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const dragRef = useRef<HTMLDivElement>(null);
  const dragOffset = useRef({ x: 0, y: 0 });

  // Reset position on step change
  useEffect(() => {
    setPosition({ x: -1, y: -1 });
  }, [currentStepId]);

  // Drag handlers
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (!dragRef.current) return;
    const rect = dragRef.current.getBoundingClientRect();
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const onMouseMove = (e: MouseEvent) => {
      setPosition({
        x: e.clientX - dragOffset.current.x,
        y: e.clientY - dragOffset.current.y,
      });
    };

    const onMouseUp = () => setIsDragging(false);

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [isDragging]);

  if (!isActive || !currentStep) return null;

  const stepIndex = currentStepId ? getStepIndex(currentStepId) : 0;
  const firstName =
    user?.user_metadata?.first_name || "there";

  const handlePrimaryAction = () => {
    if (currentStep.primaryAction?.href) {
      window.open(currentStep.primaryAction.href, "_blank");
    }
    if (currentStep.primaryAction?.action === "oauth_gmail") {
      window.location.assign("/api/gmail/auth");
    }
    if (currentStep.primaryAction?.action === "oauth_calendar") {
      window.location.assign("/api/gmail/auth?scopes=calendar");
    }
  };

  const handleSecondaryAction = () => {
    if (currentStep.secondaryAction?.action === "confirm") {
      advance();
    }
    if (currentStep.secondaryAction?.action === "skip") {
      advance(true); // skippedApollo
    }
    if (currentStep.secondaryAction?.action === "complete") {
      advance();
    }
  };

  const handleCopyTranscript = async () => {
    const text = getOnboardingTranscript(firstName);
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isDefault = position.x === -1;
  const style: React.CSSProperties = isDefault
    ? { bottom: 24, right: 24 }
    : { left: position.x, top: position.y };

  return (
    <div
      ref={dragRef}
      className={`fixed z-[1000] w-[400px] bg-white rounded-2xl shadow-2xl border border-gray-200 overflow-hidden transition-shadow ${
        isDragging ? "shadow-3xl cursor-grabbing" : ""
      }`}
      style={{ ...style, position: "fixed" }}
    >
      {/* Header — drag handle */}
      <div
        className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-100 cursor-grab active:cursor-grabbing select-none"
        onMouseDown={onMouseDown}
      >
        <div className="flex items-center gap-2">
          <GripHorizontal className="h-4 w-4 text-gray-400" />
          <span className="text-sm font-semibold text-gray-600">
            Getting Started
          </span>
        </div>
        <span className="text-xs text-gray-400">
          {stepIndex + 1}/{ONBOARDING_STEPS.length}
        </span>
      </div>

      {/* Body */}
      <div className="px-5 py-4">
        <h3 className="text-lg font-bold text-gray-900 mb-1">
          {currentStep.title}
        </h3>
        <p className="text-sm text-gray-600 mb-4">{currentStep.description}</p>

        {/* Expandable transcript area for step 11 */}
        {currentStep.expandable && (
          <div className="mb-4 max-h-48 overflow-y-auto rounded-lg bg-gray-50 border border-gray-200 p-3 text-xs text-gray-700 font-mono relative">
            <button
              onClick={handleCopyTranscript}
              className="absolute top-2 right-2 p-1.5 rounded-md bg-white border border-gray-200 hover:bg-gray-100 transition-colors"
              title="Copy transcript"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-green-600" />
              ) : (
                <Copy className="h-3.5 w-3.5 text-gray-500" />
              )}
            </button>
            <pre className="whitespace-pre-wrap">
              {getOnboardingTranscript(firstName)}
            </pre>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-3">
          {currentStep.primaryAction && (
            <button
              onClick={handlePrimaryAction}
              className="flex items-center gap-1.5 px-4 py-2 bg-primary text-white text-sm font-semibold rounded-lg hover:bg-primary/90 transition-colors"
            >
              {currentStep.primaryAction.label}
              {currentStep.primaryAction.href && (
                <ExternalLink className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          {currentStep.secondaryAction && (
            <button
              onClick={handleSecondaryAction}
              className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
            >
              {currentStep.secondaryAction.label}
            </button>
          )}
        </div>
      </div>

      {/* Footer — progress bar + skip */}
      <div className="px-5 pb-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex-1 h-1 bg-gray-100 rounded-full mr-3">
            <div
              className="h-1 bg-primary rounded-full transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
          <button
            onClick={skip}
            className="text-xs text-gray-400 hover:text-gray-600 transition-colors whitespace-nowrap"
          >
            Skip tutorial
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run tests**

```bash
cd careervine && npx vitest run src/__tests__/onboarding/onboarding-guide.test.tsx
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add careervine/src/components/onboarding/onboarding-guide.tsx careervine/src/components/onboarding/onboarding-highlight.tsx careervine/src/__tests__/onboarding/onboarding-guide.test.tsx
git commit -m "feat: add draggable onboarding guide card and highlight overlay"
```

---

## Task 8: Wire Into App Layout & Auth Flow

**Files:**
- Modify: `careervine/src/app/layout.tsx`
- Modify: `careervine/src/components/auth-provider.tsx`
- Modify: `careervine/src/app/globals.css` (or equivalent)

- [ ] **Step 1: Add OnboardingProvider and OnboardingGuide to layout.tsx**

In `careervine/src/app/layout.tsx`, add the imports and wrap in the provider stack:

```typescript
import { OnboardingProvider } from "@/components/onboarding/onboarding-provider";
import { OnboardingGuide } from "@/components/onboarding/onboarding-guide";
import { OnboardingHighlight } from "@/components/onboarding/onboarding-highlight";
```

Add `OnboardingProvider` inside `AuthProvider` and after `QuickCaptureProvider`:

```tsx
<AuthProvider>
  <ToastProvider>
    <ComposeEmailProvider>
      <QuickCaptureProvider>
        <OnboardingProvider>
          {children}
          <ComposeEmailModal />
          <QuickCaptureModal />
          <OnboardingGuide />
          <OnboardingHighlight />
        </OnboardingProvider>
      </QuickCaptureProvider>
    </ComposeEmailProvider>
  </ToastProvider>
</AuthProvider>
```

- [ ] **Step 2: Hook signup to call onboarding setup API**

In `careervine/src/components/auth-provider.tsx`, modify the `signUp` function to call the setup API after successful signup. The challenge is that `signUp` returns before the session is established (email confirmation is required).

Instead, add a `useEffect` that detects when a user first logs in and has no onboarding record:

```typescript
// Inside AuthProvider, after the existing useEffect for session listening
useEffect(() => {
  if (!user) return;

  // Check if this user needs onboarding setup
  const setupOnboarding = async () => {
    try {
      const res = await fetch("/api/onboarding/status");
      const { onboarding } = await res.json();
      if (!onboarding) {
        // First-time login — seed onboarding data
        await fetch("/api/onboarding/setup", { method: "POST" });
      }
    } catch (err) {
      console.error("Failed to check/setup onboarding:", err);
    }
  };

  setupOnboarding();
}, [user]);
```

- [ ] **Step 3: Add onboarding highlight CSS to globals**

Add to `careervine/src/app/globals.css`:

```css
.onboarding-highlight {
  position: relative;
  z-index: 999;
  box-shadow: 0 0 0 4px rgba(76, 175, 80, 0.5);
  border-radius: 8px;
  animation: onboarding-pulse 2s ease-in-out infinite;
}

@keyframes onboarding-pulse {
  0%, 100% { box-shadow: 0 0 0 4px rgba(76, 175, 80, 0.3); }
  50% { box-shadow: 0 0 0 8px rgba(76, 175, 80, 0.1); }
}
```

- [ ] **Step 4: Commit**

```bash
git add careervine/src/app/layout.tsx careervine/src/components/auth-provider.tsx careervine/src/app/globals.css
git commit -m "feat: wire onboarding into app layout and auth flow"
```

---

## Task 9: Add data-onboarding-target Attributes

**Files:**
- Modify: `careervine/src/components/navigation.tsx`
- Modify: `careervine/src/app/page.tsx`
- Modify: `careervine/src/components/home/unified-action-list.tsx`

- [ ] **Step 1: Add targets to navigation items**

In `careervine/src/components/navigation.tsx`, add `data-onboarding-target` attributes:
- Inbox link: `data-onboarding-target="nav-inbox"`
- Home link: `data-onboarding-target="nav-home"`

- [ ] **Step 2: Add target to Dawson's intro button**

In `careervine/src/components/home/unified-action-list.tsx`, find the `ActionButton` for intro and conditionally add the attribute when the contact is Dawson:

```tsx
{item.hasEmail && (
  <ActionButton
    icon={<Mail className="h-6 w-6" />}
    label="Intro"
    color="#0d9488"
    onClick={() => onIntro(item.contactId)}
    data-onboarding-target={
      item.contactName?.includes("Dawson") ? "intro-button-dawson" : undefined
    }
  />
)}
```

Note: May need to pass the `data-onboarding-target` prop through the `ActionButton` component.

- [ ] **Step 3: Add target to meeting card in day view**

In `careervine/src/app/page.tsx` or the `TodaySchedule` component, add `data-onboarding-target="onboarding-meeting"` to meeting cards that contain "Dawson" in the title.

- [ ] **Step 4: Add target to extract/analyze actions button**

Find the "Analyze" or "Extract" button in the conversation modal transcript section and add `data-onboarding-target="extract-actions-button"`.

- [ ] **Step 5: Commit**

```bash
git add careervine/src/components/navigation.tsx careervine/src/app/page.tsx careervine/src/components/home/unified-action-list.tsx
git commit -m "feat: add data-onboarding-target attributes for onboarding highlights"
```

---

## Task 10: Auto-Advance Detection

**Files:**
- Modify: `careervine/src/components/onboarding/onboarding-provider.tsx`

Several steps advance automatically based on user actions rather than manual button clicks. The provider needs to detect these events.

- [ ] **Step 1: Add auto-advance hooks to the provider**

Add detection logic for steps with `advanceOn: "automatic"`:

- **`connect_gmail`**: After OAuth redirect, check if Gmail is connected via `/api/gmail/status` or by detecting the URL params `?gmail=connected`
- **`connect_calendar`**: Similar — detect calendar OAuth completion
- **`click_intro_button`**: Listen for the compose email modal opening with `isIntro: true` for the Dawson contact
- **`compose_send_email`**: Listen for email sent event (the compose modal's send callback)
- **`read_reply`**: Detect navigation to `/inbox` and viewing the Dawson thread
- **`view_meeting`**: Detect navigation to home and meeting visible in schedule
- **`click_meeting`**: Detect conversation modal opening for the Dawson meeting
- **`paste_transcript`**: Detect transcript field receiving content
- **`extract_actions`**: Detect action item extraction completion
- **`view_dashboard_actions`**: Detect navigation to home with action items visible

The simplest approach: expose an `advanceIfStep(stepId: string)` function from the provider that other components call when the relevant action happens. This avoids complex global event detection.

```typescript
const advanceIfStep = useCallback(
  async (stepId: string, skippedApollo?: boolean) => {
    if (currentStepId === stepId) {
      await advance(skippedApollo);
    }
  },
  [currentStepId, advance]
);
```

Add `advanceIfStep` to the context value.

- [ ] **Step 2: Add advanceIfStep calls to relevant components**

In each component where an automatic step completes, call `advanceIfStep`:
- Gmail OAuth callback page: `advanceIfStep("connect_gmail")`
- Calendar OAuth callback: `advanceIfStep("connect_calendar")`
- Compose email modal open (when `isIntro` for Dawson): `advanceIfStep("click_intro_button")`
- Compose email modal send success: `advanceIfStep("compose_send_email")`
- Inbox page load (with Dawson reply visible): `advanceIfStep("read_reply")`
- Home page load (with onboarding meeting visible): `advanceIfStep("view_meeting")`
- Conversation modal open for Dawson meeting: `advanceIfStep("click_meeting")`
- Transcript paste into field: `advanceIfStep("paste_transcript")`
- Action extraction complete: `advanceIfStep("extract_actions")`
- Home page load with action items: `advanceIfStep("view_dashboard_actions")`

- [ ] **Step 3: Commit**

```bash
git add careervine/src/components/onboarding/onboarding-provider.tsx
git commit -m "feat: add auto-advance detection for onboarding steps"
```

---

## Task 11: Integration Points — Wire advanceIfStep Into Existing Components

**Files:**
- Modify: `careervine/src/app/page.tsx` (home page — detect meeting visible, action items visible)
- Modify: `careervine/src/app/inbox/page.tsx` (inbox — detect Dawson reply viewed)
- Modify: `careervine/src/components/compose-email-modal.tsx` (compose — detect intro click, send)
- Modify: `careervine/src/components/conversation-modal/index.tsx` (conversation — detect transcript paste, extraction)
- Modify: `careervine/src/app/settings/page.tsx` or OAuth callback (detect Gmail/Calendar connect)

- [ ] **Step 1: Wire Gmail/Calendar OAuth detection**

In the OAuth callback handler or the settings page that detects `?gmail=connected` URL params, add:

```typescript
const { advanceIfStep } = useOnboarding();

useEffect(() => {
  const params = new URLSearchParams(window.location.search);
  if (params.get("gmail") === "connected") {
    advanceIfStep("connect_gmail");
    advanceIfStep("connect_calendar");
  }
}, [advanceIfStep]);
```

- [ ] **Step 2: Wire compose email modal — intro click and send**

In `careervine/src/components/compose-email-modal.tsx`:

```typescript
const { advanceIfStep } = useOnboarding();

// When modal opens in intro mode for Dawson
useEffect(() => {
  if (isOpen && isIntro && prefillTo?.includes("dawson@careervine.app")) {
    advanceIfStep("click_intro_button");
  }
}, [isOpen, isIntro, prefillTo, advanceIfStep]);

// After successful send to dawson@careervine.app
const handleSendSuccess = () => {
  // ... existing send logic
  advanceIfStep("compose_send_email");
};
```

- [ ] **Step 3: Wire inbox page — Dawson reply detection**

In `careervine/src/app/inbox/page.tsx`:

```typescript
const { advanceIfStep } = useOnboarding();

useEffect(() => {
  // Check if any emails are from dawson@careervine.app
  const hasDawsonReply = emails.some(
    (e) => e.from_address === "dawson@careervine.app" && e.direction === "inbound"
  );
  if (hasDawsonReply) {
    advanceIfStep("read_reply");
  }
}, [emails, advanceIfStep]);
```

- [ ] **Step 4: Wire home page — meeting and action items detection**

In `careervine/src/app/page.tsx`:

```typescript
const { advanceIfStep } = useOnboarding();

// Detect onboarding meeting visible in schedule
useEffect(() => {
  const hasDawsonMeeting = scheduleEvents.some((e) =>
    e.title?.includes("Dawson Pitcher")
  );
  if (hasDawsonMeeting) {
    advanceIfStep("view_meeting");
  }
}, [scheduleEvents, advanceIfStep]);

// Detect action items visible after extraction
useEffect(() => {
  if (actionItems.length > 0) {
    advanceIfStep("view_dashboard_actions");
  }
}, [actionItems, advanceIfStep]);
```

- [ ] **Step 5: Wire conversation modal — transcript paste and extraction**

In `careervine/src/components/conversation-modal/index.tsx`:

```typescript
const { advanceIfStep } = useOnboarding();

// Detect transcript pasted
const handleTranscriptChange = (value: string) => {
  setTranscript(value);
  if (value.length > 100) {
    advanceIfStep("paste_transcript");
  }
};

// Detect action extraction complete
const handleExtractComplete = (items: ActionItem[]) => {
  // ... existing logic
  if (items.length > 0) {
    advanceIfStep("extract_actions");
  }
};
```

- [ ] **Step 6: Wire meeting click detection**

When the user clicks a meeting in the schedule that opens the conversation modal for Dawson's meeting:

```typescript
const handleMeetingClick = (event: ScheduleEvent) => {
  if (event.title?.includes("Dawson Pitcher")) {
    advanceIfStep("click_meeting");
  }
  // ... existing click handler
};
```

- [ ] **Step 7: Run full test suite**

```bash
cd careervine && npm run test
```
Expected: All existing tests pass. Fix any breakage from added imports/hooks.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: wire onboarding auto-advance into all integration points"
```

---

## Task 12: End-to-End Cleanup & Polish

**Files:**
- Various onboarding files

- [ ] **Step 1: Ensure calendar event cleanup on completion**

Verify that the `/api/onboarding/skip` route properly deletes the Google Calendar event. Also add cleanup to the advance route when the final step completes (wispr_recommendation → complete):

In `careervine/src/app/api/onboarding/advance/route.ts`, before setting `completed_at`, add the same cleanup logic from the skip route.

- [ ] **Step 2: Handle edge case — user already has Gmail/Calendar connected**

In the onboarding provider, after fetching status, check if Gmail is already connected. If so and step is `connect_gmail`, auto-advance. Same for calendar.

```typescript
// In OnboardingProvider, after fetchStatus
useEffect(() => {
  if (!currentStepId || !user) return;

  const checkIntegrations = async () => {
    if (currentStepId === "connect_gmail" || currentStepId === "connect_calendar") {
      const res = await fetch("/api/gmail/connection-status");
      const data = await res.json();
      if (currentStepId === "connect_gmail" && data.connected) {
        advance();
      }
      if (currentStepId === "connect_calendar" && data.calendarConnected) {
        advance();
      }
    }
  };

  checkIntegrations();
}, [currentStepId, user, advance]);
```

- [ ] **Step 3: Ensure the "I've installed it" button on extension steps works properly**

For steps 3 and 5 (install extension, import contact), the confirmation buttons should call `advance()` directly.

- [ ] **Step 4: Test the full flow manually**

Walk through all 14 steps to verify:
1. Dawson contact appears on signup
2. Gmail OAuth works and advances
3. Calendar OAuth works and advances
4. Extension links open correctly
5. Confirmation buttons advance correctly
6. Intro button highlight works for Dawson
7. AI compose opens and sends
8. Simulated reply appears in inbox
9. Follow-ups cancelled after reply
10. Meeting appears in calendar/schedule
11. Transcript copy button works
12. Action extraction produces results
13. Dashboard shows action items
14. Wispr Flow link works
15. Skip tutorial works at any point
16. Calendar event cleaned up on completion

- [ ] **Step 5: Run full test suite**

```bash
cd careervine && npm run test
```

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: polish onboarding flow — cleanup, edge cases, integration"
```

---

## Task 13: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add onboarding section to README**

Add a section describing the guided onboarding experience from a product perspective — how new users are walked through the core workflow with a hands-on tutorial.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add onboarding flow to README"
```
