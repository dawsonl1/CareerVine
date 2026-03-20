"use client";

import { useState } from "react";
import { Sprout, MessageSquare, ListChecks, Users } from "lucide-react";
import { Button } from "./ui/button";
import AuthForm from "./auth-form";

const features = [
  {
    icon: MessageSquare,
    title: "Track conversations",
    description:
      "Log meetings, calls, and chats so you never forget what was discussed.",
  },
  {
    icon: ListChecks,
    title: "Capture action items",
    description:
      "Turn promises and follow-ups into trackable tasks tied to real conversations.",
  },
  {
    icon: Users,
    title: "Stay on top of relationships",
    description:
      "See at a glance who you haven't talked to in a while and what's overdue.",
  },
];

export default function LandingPage() {
  const [showAuth, setShowAuth] = useState(false);

  if (showAuth) return <AuthForm />;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Nav */}
      <header className="w-full border-b border-outline-variant px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sprout className="h-7 w-7 text-primary" />
          <span className="text-lg font-medium text-foreground">
            CareerVine
          </span>
        </div>
        <Button variant="tonal" size="sm" onClick={() => setShowAuth(true)}>
          Sign in
        </Button>
      </header>

      {/* Hero */}
      <main className="flex-1 flex flex-col items-center justify-center px-6 py-16">
        <div className="max-w-xl text-center mb-14">
          <Sprout className="mx-auto h-14 w-14 text-primary mb-6" />
          <h1 className="text-[32px] sm:text-[40px] leading-tight font-normal text-foreground mb-4">
            Never lose track of a conversation again
          </h1>
          <p className="text-base sm:text-lg text-muted-foreground leading-relaxed mb-8">
            CareerVine helps you remember what you talked about, with who, and
            what you said you&apos;d do next.
          </p>
          <Button size="lg" onClick={() => setShowAuth(true)}>
            Get started
          </Button>
        </div>

        {/* Value props */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 max-w-3xl w-full">
          {features.map((f) => (
            <div
              key={f.title}
              className="rounded-[12px] border border-outline-variant bg-surface-container-low p-6 text-center"
            >
              <div className="mx-auto mb-4 w-11 h-11 rounded-full bg-primary-container flex items-center justify-center">
                <f.icon className="h-5 w-5 text-on-primary-container" />
              </div>
              <h3 className="text-sm font-medium text-foreground mb-1">
                {f.title}
              </h3>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {f.description}
              </p>
            </div>
          ))}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-outline-variant px-6 py-4 flex items-center justify-between text-xs text-muted-foreground">
        <span>&copy; {new Date().getFullYear()} CareerVine</span>
        <a href="/privacy" className="hover:underline">
          Privacy
        </a>
      </footer>
    </div>
  );
}
