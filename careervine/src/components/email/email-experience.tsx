"use client";

import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";
import { useCapabilities } from "@/hooks/use-capabilities";

/** Brief loading state shown while capabilities resolve or a shell chunk loads. */
function EmailExperienceSkeleton() {
  return (
    <div role="status" aria-label="Loading" className="flex min-h-[60vh] items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
    </div>
  );
}

// Lazy-load each shell so a tier's bundle ships only the code it uses (CAR-103).
// ssr:false: both shells are client-only surfaces that fetch their own data.
const InboxShell = dynamic(
  () => import("@/components/email/inbox/inbox-shell").then((m) => m.InboxShell),
  { ssr: false, loading: () => <EmailExperienceSkeleton /> },
);
const OutreachShell = dynamic(
  () => import("@/components/email/outreach/outreach-shell").then((m) => m.OutreachShell),
  { ssr: false, loading: () => <EmailExperienceSkeleton /> },
);

/**
 * The single branch point between the paid Inbox and the free Outreach (CAR-103).
 * Renders a skeleton until capabilities resolve, then picks the shell from
 * `inbox:premium` — never the wrong shell, so there is no Inbox/Outreach flash.
 */
export function EmailExperience() {
  const { can, loading } = useCapabilities();
  if (loading) return <EmailExperienceSkeleton />;
  return can("inbox:premium") ? <InboxShell /> : <OutreachShell />;
}
