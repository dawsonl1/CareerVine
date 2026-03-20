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
  ArrowRight,
  ChevronDown,
  type LucideIcon,
} from "lucide-react";
import { Button } from "./ui/button";
import AuthForm from "./auth-form";

/* ── Feature data ── */

type Feature = {
  icon: LucideIcon;
  headline: string;
  tagline: string;
  details: string[];
};

const features: Feature[] = [
  {
    icon: MessageSquare,
    headline: "Remember every conversation, word for word",
    tagline:
      "Coffee chats, Zoom calls, chance encounters. Log them all in seconds so nothing slips away.",
    details: [
      "Log meetings with date, time, type (coffee, video, phone, in-person, conference), and attendees",
      "Add rich notes and attach files for full context",
      "Quick-capture modal lets you log from anywhere in the app",
      "Lightweight interaction logging for brief touchpoints",
      "Full timeline view, searchable by contact, type, or notes",
    ],
  },
  {
    icon: Mic,
    headline: "Turn recordings into searchable notes",
    tagline:
      "Paste a transcript or drop in an audio file. Speakers are identified and everything links to your meeting.",
    details: [
      "Supports VTT, SRT, and raw text formats, auto-detected on paste or upload",
      "Upload audio files (MP3, WAV, M4A) for automatic speech-to-text",
      "Speaker resolver matches transcript speakers to meeting attendees",
      "Parsed segments stored with speaker labels for easy review",
      "AI fallback handles unusual formats automatically",
    ],
  },
  {
    icon: ListChecks,
    headline: "Never forget what you promised",
    tagline:
      "Turn \"I'll send you that intro\" into a tracked task with a due date, tied to the conversation where you said it.",
    details: [
      "Create action items from meeting notes with due dates and linked contacts",
      "Dashboard shows pending items front and center, overdue flagged in red",
      "Mark done with one click; optionally log a follow-up right after",
      "Completed items are archived but never lost. Review them anytime",
      "Every item links back to its source meeting for original context",
    ],
  },
  {
    icon: Heart,
    headline: "Know exactly who needs your attention",
    tagline:
      "Set a follow-up cadence for each contact and see at a glance who's overdue and who's thriving.",
    details: [
      "Assign follow-up frequencies: every 7, 14, 30, 90 days, or custom",
      "Color-coded health indicators from green (on track) to red (critically overdue)",
      "\"Reach Out Today\" section highlights who needs attention now",
      "Network health grid gives a bird's-eye view of your entire network",
      "Health updates automatically as you log conversations",
    ],
  },
  {
    icon: Users,
    headline: "Your entire network, organized and searchable",
    tagline:
      "Rich profiles with work history, education, tags, and a full interaction timeline for everyone you know.",
    details: [
      "Store name, company, title, location, LinkedIn, emails, and phone numbers",
      "Track work experience and education with full details",
      "Tag contacts for easy filtering: investors, alumni, mentors, or custom labels",
      "Each contact has a timeline showing every meeting, email, and action item",
      "Quick-add form lets you save someone in seconds",
    ],
  },
  {
    icon: Mail,
    headline: "Send smarter emails without leaving the app",
    tagline:
      "Connect Gmail and manage your inbox, compose with AI-powered templates, and set up automated follow-up sequences.",
    details: [
      "Full inbox with tabs for Inbox, Sent, Drafts, Scheduled, and Follow-ups",
      "Emails automatically linked to contacts so you can see every thread per person",
      "AI-powered templates for intros, follow-ups, thank-yous, and custom drafts",
      "Schedule emails to send at the right time",
      "Multi-stage follow-up sequences that auto-send and auto-cancel on reply",
    ],
  },
  {
    icon: Calendar,
    headline: "Your schedule and your network, in sync",
    tagline:
      "See your calendar in CareerVine, create meetings that sync to Google Calendar, and share your availability.",
    details: [
      "Week view with time grid and list view for quick scanning",
      "Drag-to-create: select a time slot to pre-fill a new meeting",
      "Auto-create Google Calendar events with attendee invites and Meet links",
      "RSVP statuses sync back so you always know who's confirmed",
      "Availability profiles with per-day working hours and buffer times",
    ],
  },
  {
    icon: Chrome,
    headline: "Add anyone from LinkedIn in one click",
    tagline:
      "Visit a LinkedIn profile and click import. Name, company, education, and photo are saved instantly.",
    details: [
      "Floating button appears on LinkedIn profile pages",
      "Scrapes name, headline, company, and education automatically",
      "One-click import saves the contact with all scraped data",
      "Duplicate detection checks LinkedIn URLs before importing",
      "Profile photos are downloaded and stored with the contact",
    ],
  },
];

/* ── Expandable Feature Card ── */

function FeatureCard({
  feature,
  isExpanded,
  onToggle,
}: {
  feature: Feature;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      onClick={onToggle}
      className={`
        group rounded-2xl border cursor-pointer
        transition-all duration-300 ease-out
        ${
          isExpanded
            ? "border-primary/30 bg-primary-container/8 shadow-lg"
            : "border-outline-variant bg-surface-container-low hover:border-primary/20 hover:shadow-md hover:-translate-y-0.5"
        }
      `}
    >
      {/* Card header – always visible */}
      <div className="px-8 py-6 flex items-center gap-5">
        <div
          className={`
            w-12 h-12 rounded-full flex items-center justify-center shrink-0
            transition-colors duration-300
            ${isExpanded ? "bg-primary text-on-primary" : "bg-primary-container text-on-primary-container"}
          `}
        >
          <feature.icon className="h-5 w-5" />
        </div>

        <div className="flex-1 min-w-0">
          <h3 className="text-lg font-medium text-foreground leading-snug">
            {feature.headline}
          </h3>
          <p className="text-sm text-muted-foreground leading-relaxed mt-1">
            {feature.tagline}
          </p>
        </div>

        <ChevronDown
          className={`
            h-5 w-5 text-muted-foreground shrink-0
            transition-transform duration-300
            ${isExpanded ? "rotate-180" : ""}
          `}
        />
      </div>

      {/* Expandable detail section */}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-out"
        style={{ gridTemplateRows: isExpanded ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className="px-8 pb-6">
            <div className="border-t border-outline-variant pt-5 ml-[68px]">
              <ul className="space-y-3">
                {feature.details.map((detail, j) => (
                  <li key={j} className="flex items-start gap-2.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-primary mt-[7px] shrink-0" />
                    <span className="text-sm text-muted-foreground leading-relaxed">
                      {detail}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Landing Page ── */

export default function LandingPage() {
  const [showAuth, setShowAuth] = useState(false);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

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
        <div className="max-w-3xl mx-auto">
          <Sprout className="mx-auto h-14 w-14 text-primary mb-6" />
          <h1 className="text-[36px] sm:text-[48px] leading-[1.15] font-normal text-foreground mb-5">
            Your conversations build your career.{" "}
            <span className="text-primary">Don&apos;t let them disappear.</span>
          </h1>
          <p className="text-base sm:text-lg text-muted-foreground leading-relaxed max-w-xl mx-auto mb-10">
            Every coffee chat, every &ldquo;let&apos;s circle back,&rdquo; every
            promise to make an intro. CareerVine makes sure you follow through
            on all of it.
          </p>
          <Button size="lg" onClick={() => setShowAuth(true)}>
            Get started for free <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </section>

      {/* ── Feature cards ── */}
      <section className="px-6 py-16">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-center text-[24px] sm:text-[28px] font-normal text-foreground mb-3">
            Everything you need, nothing you don&apos;t
          </h2>
          <p className="text-center text-sm text-muted-foreground mb-12 max-w-lg mx-auto">
            Click any card to see how it works.
          </p>

          <div className="flex flex-col gap-4">
            {features.map((feature, i) => (
              <FeatureCard
                key={feature.headline}
                feature={feature}
                isExpanded={expandedIndex === i}
                onToggle={() =>
                  setExpandedIndex(expandedIndex === i ? null : i)
                }
              />
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="px-6 py-20 bg-primary-container/20">
        <div className="max-w-lg mx-auto text-center">
          <h2 className="text-[24px] sm:text-[28px] font-normal text-foreground mb-3">
            Your network is your biggest asset.
            <br />
            Start treating it like one.
          </h2>
          <p className="text-sm text-muted-foreground mb-8">
            Free to use. Set up in under a minute.
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
