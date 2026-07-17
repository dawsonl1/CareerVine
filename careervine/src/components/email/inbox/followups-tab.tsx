import { Clock, Pencil, XCircle } from "lucide-react";
import type { EmailFollowUp } from "@/lib/types";
import { isOpenFollowUpMessage } from "@/lib/constants";
import type { FollowUpModalPayload } from "./inbox-types";

interface FollowUpsTabProps {
  followUps: EmailFollowUp[];
  onCancel: (followUpId: number) => void;
  onOpenFollowUp: (payload: FollowUpModalPayload) => void;
  formatDateFull: (dateStr: string) => string;
}

export function FollowUpsTab({ followUps, onCancel, onOpenFollowUp, formatDateFull }: FollowUpsTabProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-base font-medium text-foreground">
          Active follow-ups
          {followUps.length > 0 && <span className="ml-2 text-muted-foreground font-normal">({followUps.length} sequence{followUps.length !== 1 ? "s" : ""})</span>}
        </h2>
      </div>
      {followUps.length === 0 ? (
        <div className="text-center py-16">
          <Clock className="h-12 w-12 text-muted-foreground/40 mx-auto mb-4" />
          <p className="text-base text-muted-foreground">No active follow-ups.</p>
          <p className="text-sm text-muted-foreground mt-1.5">Schedule follow-ups from sent emails to automate reminders.</p>
        </div>
      ) : (
        <div className="border border-outline-variant/50 rounded-xl overflow-hidden divide-y divide-outline-variant/50">
          {followUps.map((fu) => {
            const pendingMsgs = fu.email_follow_up_messages.filter((m) => isOpenFollowUpMessage(m.status)).sort((a, b) => a.sequence_number - b.sequence_number);
            const nextMsg = pendingMsgs[0];
            return (
              <div key={fu.id} className="px-5 py-3.5 hover:bg-surface-container-low/50 transition-colors">
                <div className="flex items-center gap-3.5">
                  <div className="w-9 h-9 rounded-full bg-tertiary-container/50 flex items-center justify-center shrink-0">
                    <Clock className="h-4 w-4 text-on-tertiary-container" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2.5">
                      <span className="text-base font-medium text-foreground truncate">{fu.original_subject || "(no subject)"}</span>
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-tertiary-container/50 text-on-tertiary-container shrink-0">{pendingMsgs.length} pending</span>
                    </div>
                    <div className="flex items-center gap-2.5 mt-1">
                      <span className="text-sm text-muted-foreground truncate">To: {fu.contact_name || fu.recipient_email}</span>
                      {nextMsg && (
                        <>
                          <span className="text-sm text-muted-foreground">·</span>
                          <span className="text-sm text-muted-foreground shrink-0">Next: {formatDateFull(nextMsg.scheduled_send_at)}</span>
                        </>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2 mt-2.5">
                      {[...fu.email_follow_up_messages].sort((a, b) => a.sequence_number - b.sequence_number).map((m) => (
                        <span key={m.id} className={`text-[11px] px-2 py-0.5 rounded-full ${m.status === "sent" ? "bg-primary/15 text-primary" : m.status === "cancelled" ? "bg-surface-container-low text-muted-foreground line-through" : m.status === "expired" ? "bg-surface-container-low text-muted-foreground" : m.status === "awaiting_review" ? "bg-primary/15 text-primary font-medium" : "bg-tertiary-container/50 text-on-tertiary-container"}`}>
                          #{m.sequence_number}: Day {m.send_after_days}
                          {m.status === "sent" && " (sent)"}
                          {m.status === "cancelled" && " (cancelled)"}
                          {m.status === "expired" && " (expired)"}
                          {m.status === "awaiting_review" && " (awaiting review)"}
                          {m.status === "pending" && ` (${new Date(m.scheduled_send_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })})`}
                        </span>
                      ))}
                    </div>
                    {!fu.email_follow_up_messages.some((m) => m.status === "awaiting_review") && (
                      <p className="text-[11px] text-muted-foreground mt-1.5">Auto-cancels if they reply</p>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5 shrink-0">
                    <button type="button" onClick={() => { onOpenFollowUp({ recipientEmail: fu.recipient_email, contactName: fu.contact_name, originalSubject: fu.original_subject || "", originalSentAt: fu.original_sent_at, originalGmailMessageId: fu.original_gmail_message_id ?? "", threadId: fu.thread_id ?? "", existingFollowUp: fu }); }} className="p-2 rounded-full text-muted-foreground hover:text-primary cursor-pointer transition-colors" title="Edit follow-ups">
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button type="button" onClick={() => onCancel(fu.id)} className="p-2 rounded-full text-muted-foreground hover:text-destructive cursor-pointer transition-colors" title="Cancel all follow-ups">
                      <XCircle className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
