"use client";

import { Bot, Mic, Sparkles, Hourglass } from "lucide-react";
import ProviderKeyCard, {
  type ProviderKeyCardConfig,
} from "@/components/settings/provider-key-card";
import { RequestAiAccessButton } from "@/components/ai/ai-unavailable-notice";

function formatTrialEnd(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Setup video URLs — paste a Loom share link or self-hosted file URL to show an
 * embedded how-to above each key's steps. Null hides the video section.
 */
const OPENAI_SETUP_VIDEO_URL: string | null = null;
const DEEPGRAM_SETUP_VIDEO_URL: string | null = null;

const openaiConfig: ProviderKeyCardConfig = {
  inputId: "openai-api-key",
  endpoint: "/api/settings/openai-key",
  title: "OpenAI API key",
  icon: <Bot className="h-6 w-6 text-muted-foreground" />,
  badgeLabel: "OpenAI key",
  placeholder: "sk-...",
  videoUrl: OPENAI_SETUP_VIDEO_URL,
  videoTitle: "How to set up your OpenAI API key",
  emptyKeyError: "Paste your OpenAI API key first.",
  removeConfirm:
    "Remove your OpenAI key? Text AI features will use CareerVine's shared key if your account has access to it.",
  // Copy adapts to shared-key entitlement (CAR-26): without access, the shared
  // key isn't a fallback the user has — their own key is what turns AI on.
  intro: (status) =>
    status && !status.hasKey && !status.sharedAccess ? (
      <>
        CareerVine&apos;s text AI features (email drafts, transcript parsing, and follow-up
        suggestions) run on an OpenAI key. Add your own below to turn them on. With OpenAI&apos;s
        free daily tokens, most people pay nothing.
      </>
    ) : (
      <>
        Add your own OpenAI key to run CareerVine&apos;s text AI features (email drafts,
        transcript parsing, and follow-up suggestions) on your account
        {status?.sharedAccess ? " instead of our shared key" : ""}. With OpenAI&apos;s free daily
        tokens, most people pay nothing.
      </>
    ),
  steps: (
    <>
      <li>
        Go to{" "}
        <a
          href="https://platform.openai.com/api-keys"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          platform.openai.com/api-keys
        </a>{" "}
        and sign in (or create an account, no payment method needed for free-tier usage).
      </li>
      <li>
        Click <strong className="text-foreground font-medium">Create new secret key</strong>, name
        it &quot;CareerVine&quot;, leave permissions on{" "}
        <strong className="text-foreground font-medium">All</strong>, create.
      </li>
      <li>Copy the key immediately. OpenAI only shows it once.</li>
      <li>
        <em>(For free daily tokens)</em> Go to{" "}
        <strong className="text-foreground font-medium">
          Settings → Data controls → Sharing
        </strong>{" "}
        and turn on{" "}
        <strong className="text-foreground font-medium">
          &quot;Share inputs and outputs with OpenAI&quot;
        </strong>{" "}
        which gives your account up to 250k free tokens/day on the models CareerVine uses.{" "}
        <em>
          Heads-up: this shares your CareerVine prompts, which can include contact names and
          conversation content, with OpenAI for model training. If you&apos;d rather not, skip this
          step and add a few dollars of credit instead.
        </em>
      </li>
      <li>Paste the key below and hit Save.</li>
    </>
  ),
  dataNote: (
    <>
      Your key is encrypted before it&apos;s stored and is never sent to your browser or anyone
      else. It&apos;s only used server-side to talk to OpenAI on your behalf. Remove it anytime.
    </>
  ),
  // CAR-51: the trial's two settings moments — the quiet "first day" note
  // while it runs, and the locked state (with the request-access exit) after
  // it ends for accounts that never added a key.
  statusBanner: (status) => {
    if (status.trialState === "active") {
      return (
        <div className="flex gap-3 rounded-xl border border-outline-variant bg-surface-container-low px-4 py-3 text-sm text-foreground">
          <Sparkles className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
          <p className="text-muted-foreground leading-relaxed">
            <span className="font-medium text-foreground">AI included: your first day is on us.</span>{" "}
            {status.sharedAccessExpiresAt
              ? `Free AI until ${formatTrialEnd(status.sharedAccessExpiresAt)}. `
              : ""}
            Add your own key below to keep AI running after that.
          </p>
        </div>
      );
    }
    if (status.trialState === "expired" && !status.hasKey) {
      return (
        <div className="flex gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-foreground">
          <Hourglass className="h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
          <div className="min-w-0 space-y-1.5">
            <p className="font-medium">Your free AI day has ended</p>
            <p className="text-muted-foreground leading-relaxed">
              Add your own OpenAI key below to keep using AI, or request continued access and
              we&apos;ll follow up by email.
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <RequestAiAccessButton initialRequested={Boolean(status.accessRequestedAt)} />
            </div>
          </div>
        </div>
      );
    }
    return null;
  },
  // Honest about entitlement (CAR-26): only claim a shared-key fallback when
  // the account actually has one.
  problemBanner: (status, keyStatus) => (
    <>
      {status === "quota_exceeded"
        ? "Your key has run out of quota."
        : "Your key was rejected by OpenAI."}{" "}
      {keyStatus.sharedAccess
        ? "We've switched you back to CareerVine's shared key."
        : "Text AI features are paused until it's fixed."}{" "}
      Paste a new key or check your OpenAI billing.
    </>
  ),
};

const deepgramConfig: ProviderKeyCardConfig = {
  inputId: "deepgram-api-key",
  endpoint: "/api/settings/deepgram-key",
  title: "Deepgram API key",
  icon: <Mic className="h-6 w-6 text-muted-foreground" />,
  badgeLabel: "Deepgram key",
  placeholder: "your 40-character Deepgram key",
  videoUrl: DEEPGRAM_SETUP_VIDEO_URL,
  videoTitle: "How to set up your Deepgram API key",
  emptyKeyError: "Paste your Deepgram API key first.",
  removeConfirm:
    "Remove your Deepgram key? Transcription will use CareerVine's shared key instead.",
  intro: (
    <>
      Meeting recordings you upload are transcribed with Deepgram. CareerVine uses its shared
      Deepgram key by default. Add your own to transcribe on your own account. New Deepgram accounts
      get $200 in free credit, enough for hundreds of hours of audio.
    </>
  ),
  steps: (
    <>
      <li>
        Go to{" "}
        <a
          href="https://console.deepgram.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          console.deepgram.com
        </a>{" "}
        and sign up (no payment method needed for the free credit).
      </li>
      <li>
        Open <strong className="text-foreground font-medium">API Keys</strong> in the dashboard,
        click <strong className="text-foreground font-medium">Create a New API Key</strong>, name it
        &quot;CareerVine&quot;, leave the default permissions, and create it.
      </li>
      <li>Copy the key immediately. Deepgram only shows it once.</li>
      <li>Paste the key below and hit Save.</li>
    </>
  ),
  dataNote: (
    <>
      Your key is encrypted before it&apos;s stored and is never sent to your browser or anyone
      else. It&apos;s only used server-side to transcribe your uploaded recordings with Deepgram.
      Remove it anytime.
    </>
  ),
  problemBanner: (status) => (
    <>
      {status === "quota_exceeded"
        ? "Your Deepgram key is out of credit."
        : "Your Deepgram key was rejected."}{" "}
      We&apos;ve switched transcription back to CareerVine&apos;s shared key. Paste a new key or
      check your Deepgram account.
    </>
  ),
};

export default function AiKeySection() {
  return (
    <div className="space-y-6">
      <ProviderKeyCard config={openaiConfig} />
      <ProviderKeyCard config={deepgramConfig} />
    </div>
  );
}
