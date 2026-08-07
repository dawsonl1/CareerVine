"use client";

import DOMPurify from "dompurify";
import type { EmailMessageFull } from "@/lib/types";

/**
 * Renders one loaded message: the from/to/date header and the body (CAR-249).
 *
 * The body is Gmail-supplied HTML written by whoever sent the message, so it is
 * always sanitized before it reaches dangerouslySetInnerHTML. `bodyText` is the
 * fallback both for plain-text messages and for the free tier, whose "body" is
 * the cached snippet.
 *
 * Presentational only — the fetch, the capability gate and the ordering guard
 * live in useEmailBody, so both the contact Emails tab and the timeline detail
 * modal render an identical message from one implementation.
 */
export function EmailMessageBody({
  content,
  loading,
  failed,
  maxBodyHeightClass = "max-h-80",
}: {
  content: EmailMessageFull | null;
  loading: boolean;
  failed: boolean;
  /** The detail modal gives the body more room than the tab's inline expansion. */
  maxBodyHeightClass?: string;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2.5 text-muted-foreground text-sm py-4">
        <div className="animate-spin rounded-full h-4 w-4 border border-primary border-t-transparent" />
        Loading email…
      </div>
    );
  }

  if (failed || !content) {
    return <p className="text-sm text-muted-foreground">Failed to load email content.</p>;
  }

  return (
    <div>
      <div className="text-sm text-muted-foreground space-y-0.5 mb-4">
        <p><span className="font-medium">From:</span> {content.from}</p>
        <p><span className="font-medium">To:</span> {content.to}</p>
        <p><span className="font-medium">Date:</span> {content.date ? new Date(content.date).toLocaleString() : ""}</p>
      </div>
      {content.bodyHtml ? (
        <div
          className={`text-sm prose prose-sm max-w-none [&_*]:!text-foreground [&_a]:!text-primary overflow-auto ${maxBodyHeightClass}`}
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(content.bodyHtml) }}
        />
      ) : (
        <pre className={`text-sm text-foreground whitespace-pre-wrap overflow-auto ${maxBodyHeightClass}`}>
          {content.bodyText || "No content available"}
        </pre>
      )}
    </div>
  );
}
