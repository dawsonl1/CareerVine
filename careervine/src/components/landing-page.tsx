"use client";

import { useState } from "react";
import {
  Sprout,
  MessageSquare,
  ListChecks,
  Users,
  Mail,
  Calendar,
  Chrome,
  Mic,
  Heart,
  Clock,
  Send,
  FileText,
  Bell,
  ArrowRight,
  type LucideIcon,
} from "lucide-react";
import { Button } from "./ui/button";
import AuthForm from "./auth-form";

/* ── Feature data ── */

type Feature = {
  icon: LucideIcon;
  title: string;
  description: string;
  details: string[];
};

const features: Feature[] = [
  {
    icon: MessageSquare,
    title: "Conversation logging",
    description:
      "Every coffee chat, phone call, Zoom meeting, and email exchange — captured in one place so nothing falls through the cracks.",
    details: [
      "Log meetings with date, time, type (coffee, video, phone, in-person, conference), and attendees",
      "Add rich notes and attach files to any meeting for full context",
      "Quick-capture modal lets you log a conversation from anywhere in the app in seconds",
      "Lightweight interaction logging for brief touchpoints like a quick email or lunch",
      "Full timeline view shows every conversation in reverse chronological order, searchable by contact, type, or notes",
    ],
  },
  {
    icon: Mic,
    title: "Transcript parsing",
    description:
      "Paste a transcript, upload a text file, or drop in an audio recording — CareerVine will parse it, identify speakers, and link it to your meeting.",
    details: [
      "Supports VTT, SRT, and raw text formats — auto-detected on paste or file upload",
      "Upload audio files (MP3, WAV, M4A) for automatic speech-to-text transcription",
      "Speaker resolver matches transcript speakers to meeting attendees",
      "Parsed segments are stored with speaker labels for easy review and reference",
      "If automatic parsing fails, an AI fallback handles unusual formats",
    ],
  },
  {
    icon: ListChecks,
    title: "Action items",
    description:
      "Turn \"I'll send you that intro\" into a tracked task with a due date, linked to the conversation where you said it.",
    details: [
      "Create action items directly from meeting notes — title, description, due date, and linked contacts",
      "Dashboard shows pending items front and center, with overdue items flagged in red",
      "Mark items done with one click; optionally log a follow-up conversation right after",
      "Completed items are archived but never lost — restore or review them anytime",
      "Every action item links back to its source meeting so you always have the original context",
    ],
  },
  {
    icon: Heart,
    title: "Relationship health tracking",
    description:
      "Set a follow-up cadence for each contact and see at a glance who's overdue, who's healthy, and who you've never reached out to.",
    details: [
      "Assign follow-up frequencies per contact — every 7, 14, 30, 90 days, or a custom interval",
      "Color-coded health indicators: green (on track), yellow (due soon), orange (overdue), red (critically overdue), gray (never contacted)",
      "Dashboard \"Reach Out Today\" section highlights who needs attention right now",
      "Network health grid gives you a bird's-eye view of your entire network's status",
      "Health updates automatically as you log conversations — no manual tracking needed",
    ],
  },
  {
    icon: Users,
    title: "Contact management",
    description:
      "Rich profiles for everyone in your network — work history, education, tags, notes, and a full interaction timeline.",
    details: [
      "Store name, industry, company, job title, location, LinkedIn, emails, and phone numbers",
      "Track work experience (current and past positions) and education (school, degree, field of study)",
      "Tag contacts for easy filtering — investors, alumni, mentors, or any custom label",
      "Each contact has a full timeline tab showing every meeting, interaction, email, and action item",
      "Quick-add form on the dashboard lets you save someone in seconds — fill in details later",
    ],
  },
  {
    icon: Mail,
    title: "Gmail integration",
    description:
      "Connect your Gmail and manage your inbox without leaving CareerVine. Read, reply, compose, schedule, and set up automated follow-up sequences.",
    details: [
      "Full inbox view with tabs for Inbox, Sent, Drafts, Scheduled, Follow-ups, and Trash",
      "Emails are automatically linked to contacts — see every email thread per person",
      "Compose emails with a rich text editor; use AI-powered templates (Intro, Follow-up, Thank You, or custom) to draft messages faster",
      "Schedule emails to send later — queue up messages for the right time",
      "Set up multi-stage follow-up sequences that auto-send if the contact doesn't reply, and auto-cancel when they do",
    ],
  },
  {
    icon: Calendar,
    title: "Google Calendar sync",
    description:
      "See your schedule in CareerVine, create meetings that sync to your calendar, and define availability profiles for scheduling.",
    details: [
      "Week view with a time grid (7am–10pm) and a list view for quick scanning",
      "Drag-to-create: select a time slot on the calendar to pre-fill a new meeting form",
      "New meetings can auto-create Google Calendar events with attendee invites and optional Google Meet links",
      "Attendee RSVP statuses sync back from Google Calendar so you always know who's confirmed",
      "Define availability profiles with per-day working hours and buffer times, so you can share your openings",
    ],
  },
  {
    icon: Chrome,
    title: "LinkedIn import (Chrome extension)",
    description:
      "Visit any LinkedIn profile and import it to CareerVine with one click. Name, company, education, and photo — saved instantly.",
    details: [
      "A floating button appears on LinkedIn profile pages — click it to open the CareerVine import panel",
      "The extension scrapes profile data: name, headline, current company, and education",
      "One-click import saves the contact to your CareerVine network with all scraped data",
      "Duplicate detection checks if the LinkedIn URL is already in your network before importing",
      "Profile photos are downloaded and stored so your contacts always have a face",
    ],
  },
];

/* ── Component ── */

export default function LandingPage() {
  const [showAuth, setShowAuth] = useState(false);

  if (showAuth) return <AuthForm />;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* ── Sticky nav ── */}
      <header className="sticky top-0 z-50 w-full border-b border-outline-variant bg-background/95 backdrop-blur px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sprout className="h-7 w-7 text-primary" />
          <span className="text-lg font-medium text-foreground">
            CareerVine
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="text"
            size="sm"
            onClick={() => setShowAuth(true)}
          >
            Sign in
          </Button>
          <Button size="sm" onClick={() => setShowAuth(true)}>
            Get started
          </Button>
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="px-6 py-20 sm:py-28 text-center">
        <div className="max-w-2xl mx-auto">
          <Sprout className="mx-auto h-14 w-14 text-primary mb-6" />
          <h1 className="text-[32px] sm:text-[44px] leading-tight font-normal text-foreground mb-5">
            Never lose track of a conversation again
          </h1>
          <p className="text-base sm:text-lg text-muted-foreground leading-relaxed max-w-lg mx-auto mb-10">
            CareerVine helps you remember what you talked about, with who, and
            what you said you&apos;d do next. Track every conversation, capture
            every follow-up, and stay on top of every relationship.
          </p>
          <Button size="lg" onClick={() => setShowAuth(true)}>
            Get started — it&apos;s free <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </section>

      {/* ── Quick value props ── */}
      <section className="px-6 pb-16">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 max-w-3xl mx-auto">
          {[
            {
              icon: MessageSquare,
              label: "Log every conversation",
            },
            {
              icon: ListChecks,
              label: "Track every follow-up",
            },
            {
              icon: Heart,
              label: "Nurture every relationship",
            },
          ].map((v) => (
            <div
              key={v.label}
              className="flex items-center gap-3 rounded-[12px] border border-outline-variant bg-surface-container-low px-5 py-4"
            >
              <div className="w-10 h-10 rounded-full bg-primary-container flex items-center justify-center shrink-0">
                <v.icon className="h-5 w-5 text-on-primary-container" />
              </div>
              <span className="text-sm font-medium text-foreground">
                {v.label}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* ── Divider ── */}
      <div className="border-t border-outline-variant" />

      {/* ── Feature sections ── */}
      <section className="px-6 py-20">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-center text-[24px] sm:text-[28px] font-normal text-foreground mb-4">
            Everything you need to manage your network
          </h2>
          <p className="text-center text-sm text-muted-foreground mb-16 max-w-lg mx-auto">
            From logging a quick coffee chat to managing automated email
            follow-ups — CareerVine handles the full lifecycle of professional
            relationships.
          </p>

          <div className="space-y-16">
            {features.map((feature, i) => (
              <div key={feature.title} className="group">
                {/* Header */}
                <div className="flex items-start gap-4 mb-4">
                  <div className="w-11 h-11 rounded-full bg-primary-container flex items-center justify-center shrink-0 mt-0.5">
                    <feature.icon className="h-5 w-5 text-on-primary-container" />
                  </div>
                  <div>
                    <h3 className="text-lg font-medium text-foreground">
                      {feature.title}
                    </h3>
                    <p className="text-sm text-muted-foreground leading-relaxed mt-1">
                      {feature.description}
                    </p>
                  </div>
                </div>

                {/* Detail bullets */}
                <ul className="ml-[60px] space-y-2.5">
                  {feature.details.map((detail, j) => (
                    <li key={j} className="flex items-start gap-2.5">
                      <div className="w-1.5 h-1.5 rounded-full bg-primary mt-[7px] shrink-0" />
                      <span className="text-sm text-muted-foreground leading-relaxed">
                        {detail}
                      </span>
                    </li>
                  ))}
                </ul>

                {/* Separator between features (not after last) */}
                {i < features.length - 1 && (
                  <div className="border-t border-outline-variant mt-16" />
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="px-6 py-20 bg-primary-container/20">
        <div className="max-w-lg mx-auto text-center">
          <h2 className="text-[24px] sm:text-[28px] font-normal text-foreground mb-3">
            Ready to take control of your network?
          </h2>
          <p className="text-sm text-muted-foreground mb-8">
            Sign up in seconds. No credit card required.
          </p>
          <Button size="lg" onClick={() => setShowAuth(true)}>
            Create your free account <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-outline-variant px-6 py-4 flex items-center justify-between text-xs text-muted-foreground">
        <span>&copy; {new Date().getFullYear()} CareerVine</span>
        <a href="/privacy" className="hover:underline">
          Privacy
        </a>
      </footer>
    </div>
  );
}
