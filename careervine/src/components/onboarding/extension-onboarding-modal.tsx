"use client";

/**
 * Extension-onboarding flow modal (CAR-68). Opened by the seeded home-page
 * to-do; steps are keyed off users.extension_onboarding_state so a closed tab
 * resumes exactly where the user left off.
 *
 * The waiting steps (connect / first contact / email contact) are advanced
 * server-side — the api-handler stamps extension_last_seen_at and
 * /api/contacts/import flips the state. This component only polls, and defers
 * showing a newly-advanced step until the tab is visible so the confetti
 * lands when the user actually returns (per the FigJam).
 *
 * Authoritative flow: Dawson's FigJam — "Chrome Extension onboarding flow chart".
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Chrome, Download, Linkedin, Mail, Sparkles, Trash2, X } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { useAuth } from "@/components/auth-provider";
import { useExtensionOnboarding } from "./extension-onboarding-context";
import { ConfettiBurst } from "./confetti-burst";
import {
  advanceExtensionOnboardingState,
  getExtensionOnboardingSnapshot,
  type ExtensionOnboardingState,
} from "@/lib/onboarding/extension-state";
import { deleteActionItem, getOnboardingActionItemId, updateActionItem } from "@/lib/queries";
import { isChromeLike } from "@/lib/browser-detect";
import { track } from "@/lib/analytics/client";
import { EXTENSION_STORE_URL } from "@/lib/extension-store";

const CV_STORE_URL = EXTENSION_STORE_URL;
const APOLLO_STORE_URL =
  "https://chromewebstore.google.com/detail/apolloio-free-b2b-phone-n/alhgpfoeiimagjlnfekdhkjlkiomcapa";

// R2 (dawsonsprojects-assets bucket via its assets.careervine.app custom
// domain, careervine/onboarding/ prefix). Placeholder clips until Dawson
// records the real ones — <VideoLoop> degrades to a caption card if a URL
// 404s, so the flow ships before the recordings.
const VIDEO_BASE = "https://assets.careervine.app/careervine/onboarding";
const VIDEOS = {
  addToNetwork: `${VIDEO_BASE}/add-to-network.mp4`,
  apolloExtract: `${VIDEO_BASE}/apollo-extract.mp4`,
  bothTogether: `${VIDEO_BASE}/both-together.mp4`,
};

const POLL_MS = 4000;

const EMAIL_ALTERNATIVES = [
  { name: "Hunter.io", url: "https://hunter.io" },
  { name: "RocketReach", url: "https://rocketreach.co" },
  { name: "ContactOut", url: "https://contactout.com" },
];

/* ── Shared bits ── */

function VideoLoop({ src, caption }: { src: string; caption: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="mt-4 flex h-44 items-center justify-center rounded-2xl bg-muted px-6 text-center">
        <p className="text-sm text-muted-foreground">{caption}</p>
      </div>
    );
  }
  return (
    <video
      className="mt-4 w-full rounded-2xl bg-muted"
      src={src}
      autoPlay
      loop
      muted
      playsInline
      onError={() => setFailed(true)}
      aria-label={caption}
    />
  );
}

function PrimaryButton({
  onClick,
  children,
  disabled = false,
}: {
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="h-12 w-full rounded-full bg-primary text-base font-semibold text-primary-foreground shadow-md transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
    >
      {children}
    </button>
  );
}

function WaitingHint({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-5 flex items-center justify-center gap-2 text-center text-xs text-muted-foreground">
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />
      {children}
    </p>
  );
}

/* ── Modal ── */

export function ExtensionOnboardingModal() {
  const { user } = useAuth();
  const { isOpen, actionItemId, close } = useExtensionOnboarding();
  const router = useRouter();

  const [state, setState] = useState<ExtensionOnboardingState | null>(null);
  const [contactId, setContactId] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const [offerReveal, setOfferReveal] = useState(false);
  const [doneReveal, setDoneReveal] = useState(false);

  // A remote advance seen while the tab is hidden is held here and applied on
  // the next visibilitychange→visible, so confetti plays when the user is
  // actually looking (FigJam: "auto advance when focus is back on the tab").
  const pendingRef = useRef<{ state: ExtensionOnboardingState; contactId: number | null } | null>(null);

  // Mirror of `state` so callbacks can read the current step without going
  // through a setState updater (updaters must stay pure — the deep-review
  // flagged a pendingRef write inside one).
  const stateRef = useRef<ExtensionOnboardingState | null>(null);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Apply a server-observed state, deferring to pendingRef while the tab is
  // hidden. Fires the step analytics event only when a transition is actually
  // shown (server-driven advances were previously invisible to the funnel).
  const applyRemoteState = useCallback(
    (next: ExtensionOnboardingState, nextContactId: number | null) => {
      setContactId((prev) => nextContactId ?? prev);
      const prev = stateRef.current;
      if (prev === next) return;
      if (document.hidden && prev !== null) {
        pendingRef.current = { state: next, contactId: nextContactId };
        return;
      }
      setState(next);
      track("extension_onboarding_step", { state: next });
    },
    [],
  );

  // Load current state when the modal opens. A failed read closes the modal
  // (the to-do row remains, so the user just clicks again) — it must NOT
  // fabricate a state; a fabricated "done" here falsely completed the flow.
  useEffect(() => {
    if (!isOpen || !user) return;
    let cancelled = false;
    getExtensionOnboardingSnapshot(user.id).then((snap) => {
      if (cancelled) return;
      if (!snap) {
        close();
        return;
      }
      setConnected(!!snap.extensionLastSeenAt);
      setContactId(snap.contactId);
      setState(snap.state);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, user, close]);

  // Poll while a waiting step is on screen.
  const waiting =
    state === "awaiting_connect" || state === "awaiting_first_contact" || state === "awaiting_email_contact";
  useEffect(() => {
    if (!isOpen || !user || !waiting) return;
    const id = setInterval(async () => {
      const snap = await getExtensionOnboardingSnapshot(user.id);
      // Transient read failure — keep the current step and retry next tick.
      if (!snap) return;
      // The connect step is client-advanced: any extension sighting counts
      // (Dawson: already-connected users skip install/login entirely). Skip
      // once an advance is already held for refocus, so a backgrounded tab
      // doesn't re-issue the same write every tick.
      if (state === "awaiting_connect" && snap.extensionLastSeenAt && !pendingRef.current) {
        const next = await advanceExtensionOnboardingState(user.id, "awaiting_first_contact");
        if (next !== null) applyRemoteState(next, snap.contactId);
        return;
      }
      applyRemoteState(snap.state, snap.contactId);
    }, POLL_MS);
    return () => clearInterval(id);
  }, [isOpen, user, waiting, state, applyRemoteState]);

  // Apply a held advance when the tab becomes visible again.
  useEffect(() => {
    const onVisible = () => {
      if (document.hidden || !pendingRef.current) return;
      const pending = pendingRef.current;
      pendingRef.current = null;
      setContactId((prev) => pending.contactId ?? prev);
      setState(pending.state);
      track("extension_onboarding_step", { state: pending.state });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // Staged reveals for the two celebration steps.
  useEffect(() => {
    if (state !== "email_offer") return setOfferReveal(false);
    const t = setTimeout(() => setOfferReveal(true), 4000);
    return () => clearTimeout(t);
  }, [state]);
  useEffect(() => {
    if (state !== "done") return setDoneReveal(false);
    const t = setTimeout(() => setDoneReveal(true), 3000);
    return () => clearTimeout(t);
  }, [state]);

  // Terminal states retire the seeded to-do. Falls back to looking the row
  // up by source when the modal was opened without an explicit id.
  const completeTodo = useCallback(async () => {
    try {
      const id = actionItemId ?? (user ? await getOnboardingActionItemId(user.id) : null);
      if (!id) return;
      await updateActionItem(id, {
        is_completed: true,
        completed_at: new Date().toISOString(),
      });
      window.dispatchEvent(new CustomEvent("careervine:onboarding-todo-changed"));
    } catch {
      // The row staying open is harmless; the flow state is already terminal.
    }
  }, [actionItemId, user]);
  useEffect(() => {
    if (state === "done") {
      completeTodo();
      track("extension_onboarding_completed", { apollo: true });
    }
  }, [state, completeTodo]);

  const advance = useCallback(
    async (next: ExtensionOnboardingState) => {
      if (!user) return;
      const prev = stateRef.current;
      const persisted = await advanceExtensionOnboardingState(user.id, next);
      // null = state couldn't be read; nothing was written — stay put so the
      // user can retry, rather than fabricating a step.
      if (persisted === null || persisted === prev) return;
      setState(persisted);
      track("extension_onboarding_step", { state: persisted });
    },
    [user],
  );

  const handleStart = useCallback(async () => {
    track("extension_onboarding_started", {});
    // Fast-forward: extension already installed + logged in → skip straight
    // to the LinkedIn step.
    await advance(connected ? "awaiting_first_contact" : "started");
  }, [advance, connected]);

  const handleDeleteTask = useCallback(async () => {
    track("extension_onboarding_deleted", {});
    try {
      const id = actionItemId ?? (user ? await getOnboardingActionItemId(user.id) : null);
      if (id) {
        await deleteActionItem(id);
        window.dispatchEvent(new CustomEvent("careervine:onboarding-todo-changed"));
      }
    } catch {
      // Leave the row; the user can delete it again from the list.
    }
    close();
  }, [actionItemId, user, close]);

  const handleDeclineApollo = useCallback(async () => {
    if (!user) return;
    await advanceExtensionOnboardingState(user.id, "completed_no_apollo");
    track("extension_onboarding_completed", { apollo: false });
    await completeTodo();
    close();
    if (contactId) router.push(`/contacts/${contactId}`);
  }, [user, completeTodo, close, contactId, router]);

  if (!isOpen || !user || state === null) return null;
  // completed_no_apollo has nothing to show — its handler already closed the
  // modal and redirected to the new contact. A real "done" MUST fall through:
  // its celebration screen below is the flow's finale (the deep-review found
  // an isExtensionOnboardingDone() guard here made that screen dead code).
  if (state === "completed_no_apollo") return null;

  const chromeOk = isChromeLike();

  return (
    <Modal isOpen={isOpen} onClose={close} size="lg">
      <div className="relative px-2 pb-2">
        {/* Close — progress persists server-side; the to-do reopens the flow */}
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          className="absolute -right-2 -top-2 z-10 rounded-full p-2 text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
        >
          <X className="h-5 w-5" />
        </button>
        {/* ── Intro: the to-do was clicked ── */}
        {state === "not_started" && (
          <div>
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
              <Chrome className="h-7 w-7 text-primary" />
            </div>
            <h2 className="mt-4 text-center text-2xl font-semibold text-foreground">
              Import contacts straight from LinkedIn
            </h2>
            <p className="mt-3 text-center text-sm text-muted-foreground">
              The CareerVine Chrome extension adds anyone on LinkedIn to your network in one
              click: name, role, company, education, all filled in for you. This guided setup
              walks you through installing it and importing your first contact.
            </p>
            {!chromeOk && (
              <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-center text-sm text-amber-800">
                This setup requires Google Chrome. Open careervine.app in Chrome to continue.
              </p>
            )}
            <div className="mt-6 space-y-3">
              <PrimaryButton onClick={handleStart} disabled={!chromeOk}>
                Start (est. 3 min)
              </PrimaryButton>
              <button
                type="button"
                onClick={handleDeleteTask}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-full text-sm font-medium text-muted-foreground transition-colors hover:text-destructive cursor-pointer"
              >
                <Trash2 className="h-4 w-4" /> Delete task
              </button>
            </div>
          </div>
        )}

        {/* ── Why: tedium explainer + store link ── */}
        {state === "started" && (
          <div>
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
              <Download className="h-7 w-7 text-primary" />
            </div>
            <h2 className="mt-4 text-center text-2xl font-semibold text-foreground">
              Never type contact details again
            </h2>
            <p className="mt-3 text-center text-sm text-muted-foreground">
              Filling in someone&apos;s name, company, role, and education by hand is tedious and
              boring. The extension reads the LinkedIn profile you&apos;re looking at and does all
              of it for you: one click, full contact.
            </p>
            <div className="mt-6">
              <PrimaryButton
                onClick={() => {
                  window.open(CV_STORE_URL, "_blank", "noopener");
                  advance("awaiting_connect");
                }}
              >
                Get the extension from the Chrome Web Store
              </PrimaryButton>
            </div>
          </div>
        )}

        {/* ── Wait: extension login ── */}
        {state === "awaiting_connect" && (
          <div>
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
              <Chrome className="h-7 w-7 text-primary" />
            </div>
            <h2 className="mt-4 text-center text-2xl font-semibold text-foreground">
              Log in to the Chrome extension
            </h2>
            <p className="mt-3 text-center text-sm text-muted-foreground">
              Once it&apos;s installed, open the extension from your browser toolbar and sign in
              with your CareerVine account. We&apos;ll pick this up automatically.
            </p>
            <WaitingHint>Waiting for the extension to connect…</WaitingHint>
          </div>
        )}

        {/* ── Wait: first import ── */}
        {state === "awaiting_first_contact" && (
          <div>
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
              <Linkedin className="h-7 w-7 text-primary" />
            </div>
            <h2 className="mt-4 text-center text-2xl font-semibold text-foreground">
              Now it&apos;s time to go to LinkedIn
            </h2>
            <p className="mt-3 text-center text-sm text-muted-foreground">
              Navigate to the profile of someone you&apos;d like in your network, someone you
              already know and don&apos;t want to lose touch with, or someone you want to get to
              know. Then click the CareerVine tab on the side of the page and hit{" "}
              <span className="font-medium text-foreground">Save Contact</span>.
            </p>
            <VideoLoop
              src={VIDEOS.addToNetwork}
              caption="Demo: opening the CareerVine panel on a LinkedIn profile and clicking Save Contact."
            />
            <div className="mt-6">
              <PrimaryButton onClick={() => window.open("https://www.linkedin.com", "_blank", "noopener")}>
                Open LinkedIn
              </PrimaryButton>
            </div>
            <WaitingHint>
              This page will advance after you&apos;ve added your first contact through the
              extension.
            </WaitingHint>
          </div>
        )}

        {/* ── Celebrate: first contact + Apollo offer ── */}
        {state === "email_offer" && (
          <div>
            <ConfettiBurst className="rounded-[28px]" />
            <h2 className="mt-2 text-center text-2xl font-semibold text-foreground">
              🎉 Congratulations, you&apos;ve added your first contact
            </h2>
            <p className="mt-3 text-center text-sm text-muted-foreground">
              Your career vine has grown a little bigger.
            </p>
            <div
              className={`mt-7 transition-all duration-700 ${
                offerReveal ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0 pointer-events-none"
              }`}
            >
              <p className="text-center text-sm font-medium text-foreground">
                Would you like to learn how to find this contact&apos;s email address?
              </p>
              <div className="mt-4 space-y-3">
                <PrimaryButton onClick={() => advance("apollo_intro")}>
                  Yes, show me how
                </PrimaryButton>
                <button
                  type="button"
                  onClick={handleDeclineApollo}
                  className="h-11 w-full rounded-full text-sm font-medium text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
                >
                  No, I want to see my new contact
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Apollo explainer ── */}
        {state === "apollo_intro" && (
          <div>
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
              <Mail className="h-7 w-7 text-primary" />
            </div>
            <h2 className="mt-4 text-center text-2xl font-semibold text-foreground">
              Meet Apollo.io
            </h2>
            <p className="mt-3 text-center text-sm text-muted-foreground">
              Apollo is a free tool that finds people&apos;s <span className="font-medium text-foreground">work email addresses</span>.
              Pair it with CareerVine and almost anyone on LinkedIn becomes someone you can
              actually reach out to.
            </p>
            <div className="mt-6">
              <PrimaryButton onClick={() => advance("apollo_install")}>Show me how</PrimaryButton>
            </div>
          </div>
        )}

        {/* ── Apollo install ── */}
        {state === "apollo_install" && (
          <div>
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
              <Download className="h-7 w-7 text-primary" />
            </div>
            <h2 className="mt-4 text-center text-2xl font-semibold text-foreground">
              Install the Apollo Chrome extension
            </h2>
            <p className="mt-3 text-center text-sm text-muted-foreground">
              Apollo works the same way CareerVine does: a panel right on the LinkedIn profile
              you&apos;re viewing. Install it, then create a free Apollo account when it asks.
            </p>
            <div className="mt-6 space-y-3">
              <PrimaryButton onClick={() => window.open(APOLLO_STORE_URL, "_blank", "noopener")}>
                Get Apollo from the Chrome Web Store
              </PrimaryButton>
              <button
                type="button"
                onClick={() => advance("apollo_howto")}
                className="h-11 w-full rounded-full text-sm font-medium text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
              >
                Go to the next step
              </button>
            </div>
          </div>
        )}

        {/* ── Apollo how-to ── */}
        {state === "apollo_howto" && (
          <div>
            <h2 className="mt-2 text-center text-2xl font-semibold text-foreground">
              Extracting an email with Apollo
            </h2>
            <p className="mt-3 text-center text-sm text-muted-foreground">
              On any LinkedIn profile, open the Apollo panel and click{" "}
              <span className="font-medium text-foreground">Access email</span>. Apollo reveals
              the person&apos;s work email in a couple of seconds.
            </p>
            <VideoLoop
              src={VIDEOS.apolloExtract}
              caption="Demo: revealing a work email with the Apollo panel on a LinkedIn profile."
            />
            <div className="mt-6">
              <PrimaryButton onClick={() => advance("awaiting_email_contact")}>
                See how they work together
              </PrimaryButton>
            </div>
          </div>
        )}

        {/* ── Wait: contact with email ── */}
        {state === "awaiting_email_contact" && (
          <div>
            <h2 className="mt-2 text-center text-2xl font-semibold text-foreground">
              Better together
            </h2>
            <p className="mt-3 text-center text-sm text-muted-foreground">
              With both panels open on a LinkedIn profile: reveal the email in Apollo, paste it
              into the CareerVine panel&apos;s email field, and save. Try it now: add another
              contact, this time with their email.
            </p>
            <VideoLoop
              src={VIDEOS.bothTogether}
              caption="Demo: copying the email from Apollo into the CareerVine panel, then saving the contact."
            />
            <WaitingHint>
              This page will advance after you save a contact with an email through the
              extension.
            </WaitingHint>
          </div>
        )}

        {/* ── Celebrate: done ── */}
        {state === "done" && (
          <div>
            <ConfettiBurst className="rounded-[28px]" />
            <h2 className="mt-2 text-center text-2xl font-semibold text-foreground">
              🎉 You&apos;re a networking machine
            </h2>
            <p className="mt-3 text-center text-sm text-muted-foreground">
              You now know how to find and save almost anyone on LinkedIn, with an email you can
              actually reach them at.
            </p>
            <div
              className={`mt-7 transition-all duration-700 ${
                doneReveal ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0 pointer-events-none"
              }`}
            >
              <p className="flex items-start gap-2 rounded-xl bg-muted px-4 py-3 text-sm text-muted-foreground">
                <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span>
                  If you ever run out of Apollo&apos;s free credits, similar tools like{" "}
                  {EMAIL_ALTERNATIVES.map((alt, i) => (
                    <span key={alt.name}>
                      <a
                        href={alt.url}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-foreground underline underline-offset-2"
                      >
                        {alt.name}
                      </a>
                      {i < EMAIL_ALTERNATIVES.length - 2 ? ", " : i === EMAIL_ALTERNATIVES.length - 2 ? ", and " : ""}
                    </span>
                  ))}{" "}
                  also offer free email lookups.
                </span>
              </p>
              <div className="mt-4">
                <PrimaryButton onClick={close}>Grow your Career Vine</PrimaryButton>
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
