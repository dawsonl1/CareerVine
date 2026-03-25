"use client";

import { useState, useEffect } from "react";
import { Mail, X, Check, Clock } from "lucide-react";
import { useAuth } from "@/components/auth-provider";

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
  const [sequences, setSequences] = useState<FollowUpSequence[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || !contactId) return;
    fetch(`/api/email-follow-ups?contactId=${contactId}`)
      .then((r) => r.json())
      .then((data) => setSequences(data.sequences || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [user, contactId]);

  const handleCancel = async (sequenceId: number) => {
    try {
      await fetch(`/api/email-follow-ups/${sequenceId}`, {
        method: "DELETE",
      });
      setSequences((prev) =>
        prev.map((s) =>
          s.id === sequenceId ? { ...s, status: "cancelled_user" } : s
        )
      );
    } catch {
      // silent
    }
  };

  if (loading || sequences.length === 0) return null;

  return (
    <div className="rounded-[20px] border border-outline-variant/60 bg-white p-5">
      <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
        <Mail className="h-4 w-4" />
        Follow-up sequences
      </h3>
      <div className="space-y-3">
        {sequences.map((seq) => {
          const sentCount = seq.messages.filter((m) => m.status === "sent").length;
          const totalCount = seq.messages.length;
          const nextPending = seq.messages.find((m) => m.status === "pending");
          const isActive = seq.status === "active";
          const isCancelledReply = seq.status === "cancelled_reply";

          return (
            <div
              key={seq.id}
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
                      They replied — cancelled
                    </div>
                  )}
                  {seq.status === "completed" && (
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Check className="h-3.5 w-3.5" />
                      {totalCount} follow-ups sent
                    </div>
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
