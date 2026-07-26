"use client";

import { useState, useEffect, useCallback } from "react";
import { Mail, X, Check, Clock } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { useToast } from "@/components/ui/toast";
import { apiFetch, apiSend } from "@/lib/api-client";
import { withToastOnError } from "@/lib/with-toast-on-error";

interface FollowUpSequence {
  id: number;
  status: string;
  original_subject: string;
  original_sent_at: string;
  messages: Array<{
    id: number;
    sequence_number: number;
    status: string;
    scheduled_send_at: string;
    sent_at: string | null;
  }>;
}

export function ContactFollowUpStatus({ contactId }: { contactId: number }) {
  const { user } = useAuth();
  const { error: toastError } = useToast();
  const [sequences, setSequences] = useState<FollowUpSequence[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  /**
   * `mode` decides who owns the failure. An initial load that fails has nothing
   * on screen to preserve, so it says so; a re-sync after a cancel keeps the
   * list it already has rather than blanking it over a transient blip.
   */
  const loadSequences = useCallback(
    async (mode: "initial" | "resync" = "initial") => {
      if (!user || !contactId) return;
      try {
        const data = await apiFetch<{ sequences?: FollowUpSequence[] }>(
          `/api/email-follow-ups?contactId=${contactId}`,
        );
        setSequences(data.sequences || []);
        setLoadFailed(false);
      } catch {
        // Unchecked, a non-2xx left `sequences` empty and the whole card
        // returned null, so a failed read was indistinguishable from "this
        // contact has no follow-ups" (CAR-183).
        if (mode === "initial") setLoadFailed(true);
      } finally {
        setLoading(false);
      }
    },
    [user, contactId],
  );

  useEffect(() => {
    void loadSequences();
  }, [loadSequences]);

  const handleCancel = async (sequenceId: number) => {
    // The route answers 404 on an ownership miss and 500 on a cascade failure,
    // neither of which rejects a bare fetch. Marking the row cancelled without
    // checking meant the UI said "Cancelled" while the sequence kept emailing
    // the contact (CAR-183), so the state update is gated on the write landing.
    const cancelled = await withToastOnError(
      () => apiSend(`/api/email-follow-ups/${sequenceId}`, { method: "DELETE" }),
      toastError,
      "Couldn't cancel that follow-up sequence. Please try again.",
    );
    if (!cancelled) {
      // Re-sync instead of leaving the row asserting a state the server just
      // refused. On a 404 the sequence is gone or was never ours, and the load
      // effect's deps never change again, so without this the row would keep
      // offering a Cancel button that can never succeed.
      void loadSequences("resync");
      return;
    }

    setSequences((prev) =>
      prev.map((s) =>
        s.id === sequenceId ? { ...s, status: "cancelled_user" } : s
      )
    );
  };

  if (loading) return null;

  if (loadFailed && sequences.length === 0) {
    return (
      <div className="rounded-[20px] border border-outline-variant/60 bg-white p-5">
        <h3 className="text-sm font-semibold text-foreground mb-2 flex items-center gap-2">
          <Mail className="h-4 w-4" />
          Follow-up sequences
        </h3>
        <p className="text-sm text-muted-foreground">
          Couldn&apos;t load follow-up sequences.{" "}
          <button
            type="button"
            onClick={() => { setLoading(true); void loadSequences(); }}
            className="text-primary hover:underline cursor-pointer"
          >
            Try again
          </button>
        </p>
      </div>
    );
  }

  if (sequences.length === 0) return null;

  return (
    <div
      data-testid="followup-sequences-card"
      className="rounded-[20px] border border-outline-variant/60 bg-white p-5"
    >
      <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
        <Mail className="h-4 w-4" />
        Follow-up sequences
      </h3>
      <div className="space-y-3">
        {sequences.map((seq) => {
          const sentCount = seq.messages.filter((m) => m.status === "sent").length;
          const totalCount = seq.messages.length;
          // A step whose send driver died between Gmail accepting the message
          // and the mark-sent write. Delivery is genuinely unknown, so it may
          // never be counted as sent (CAR-207 review).
          const unconfirmedCount = seq.messages.filter((m) => m.status === "failed").length;
          const nextPending = seq.messages.find((m) => m.status === "pending");
          const isActive = seq.status === "active";
          const isCancelledReply = seq.status === "cancelled_reply";

          return (
            <div
              key={seq.id}
              data-testid={`followup-sequence-${seq.id}`}
              data-status={seq.status}
              className="rounded-xl bg-surface-container-low p-3 text-sm"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  {isActive && (
                    <>
                      <div className="flex items-center gap-1.5 text-primary font-medium">
                        <Clock className="h-3.5 w-3.5" />
                        {sentCount} of {totalCount} sent
                      </div>
                      {nextPending && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Next:{" "}
                          {new Date(nextPending.scheduled_send_at).toLocaleDateString(
                            "en-US",
                            { month: "short", day: "numeric" }
                          )}
                        </p>
                      )}
                    </>
                  )}
                  {isCancelledReply && (
                    <div className="flex items-center gap-1.5 text-primary font-medium">
                      <Check className="h-3.5 w-3.5" />
                      They replied, so we cancelled
                    </div>
                  )}
                  {seq.status === "completed" && (
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Check className="h-3.5 w-3.5" />
                      {/* sentCount, not totalCount. This counted every message in
                          the sequence as sent, so a cancelled or unconfirmed step
                          was reported as delivered. */}
                      {sentCount} follow-up{sentCount === 1 ? "" : "s"} sent
                    </div>
                  )}
                  {unconfirmedCount > 0 && (
                    <p className="mt-1 text-xs text-destructive">
                      {unconfirmedCount === 1
                        ? "1 step could not be confirmed. It may already have been delivered, so check your Gmail Sent folder before emailing again."
                        : `${unconfirmedCount} steps could not be confirmed. They may already have been delivered, so check your Gmail Sent folder before emailing again.`}
                    </p>
                  )}
                  {seq.status === "cancelled_user" && (
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <X className="h-3.5 w-3.5" />
                      Cancelled
                    </div>
                  )}
                </div>
                {isActive && (
                  <button
                    type="button"
                    data-testid="followup-sequence-cancel"
                    onClick={() => handleCancel(seq.id)}
                    className="text-xs text-muted-foreground hover:text-destructive transition-colors cursor-pointer shrink-0"
                  >
                    Cancel
                  </button>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1 truncate">
                Re: {seq.original_subject}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
