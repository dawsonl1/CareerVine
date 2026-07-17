import { Clock, Send, RotateCcw, XCircle } from "lucide-react";
import type { EmailFollowUp, ScheduledEmail } from "@/lib/types";
import { isOpenFollowUpMessage } from "@/lib/constants";
import type { FollowUpModalPayload } from "./inbox-types";

interface ScheduledTabProps {
  scheduledEmails: ScheduledEmail[];
  followUps: EmailFollowUp[];
  contactMap: Record<number, string>;
  onRetry: (id: number) => void;
  onCancel: (id: number) => void;
  onOpenFollowUp: (payload: FollowUpModalPayload) => void;
  formatDateFull: (dateStr: string) => string;
}

export function ScheduledTab({
  scheduledEmails,
  followUps,
  contactMap,
  onRetry,
  onCancel,
  onOpenFollowUp,
  formatDateFull,
}: ScheduledTabProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-base font-medium text-foreground">
          Scheduled emails
          {scheduledEmails.length > 0 && <span className="ml-2 text-muted-foreground font-normal">({scheduledEmails.length})</span>}
        </h2>
      </div>
      {scheduledEmails.length === 0 ? (
        <div className="text-center py-16">
          <Send className="h-12 w-12 text-muted-foreground/40 mx-auto mb-4" />
          <p className="text-base text-muted-foreground">No scheduled emails.</p>
          <p className="text-sm text-muted-foreground mt-1.5">Use the &quot;Schedule&quot; option in Compose to queue emails for later.</p>
        </div>
      ) : (
        <div className="border border-outline-variant/50 rounded-xl overflow-hidden divide-y divide-outline-variant/50">
          {scheduledEmails.map((se) => {
            const contactName = se.matched_contact_id ? contactMap[se.matched_contact_id] : null;
            const linkedFU = followUps.find((fu) => fu.scheduled_email_id === se.id);
            return (
              <div key={se.id} className="px-5 py-3.5 hover:bg-surface-container-low/50 transition-colors">
                <div className="flex items-center gap-3.5">
                  <div className="w-9 h-9 rounded-full bg-tertiary-container flex items-center justify-center shrink-0">
                    <Clock className="h-4 w-4 text-on-tertiary-container" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2.5">
                      <span className="text-base font-medium text-foreground truncate">{se.subject}</span>
                      {se.status === "failed" ? (
                        <span
                          className="text-[11px] px-2 py-0.5 rounded-full bg-destructive/10 text-destructive shrink-0"
                          title="Sending was interrupted, so this email may not have gone out. Check your Gmail Sent folder, then retry or cancel it."
                        >
                          Didn&apos;t send
                        </span>
                      ) : (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-tertiary-container/50 text-on-tertiary-container shrink-0">Scheduled</span>
                      )}
                      {linkedFU && (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-tertiary-container/30 text-on-tertiary-container shrink-0">
                          + {linkedFU.email_follow_up_messages.filter((m) => isOpenFollowUpMessage(m.status)).length} follow-up(s)
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2.5 mt-1">
                      <span className="text-sm text-muted-foreground truncate">To: {contactName || se.recipient_email}</span>
                      <span className="text-sm text-muted-foreground">·</span>
                      <span className="text-sm text-muted-foreground shrink-0">
                        {se.status === "failed" ? `Was due ${formatDateFull(se.scheduled_send_at)}` : `Sends ${formatDateFull(se.scheduled_send_at)}`}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {se.status === "failed" && (
                      <button type="button" onClick={() => onRetry(se.id)} className="p-2 rounded-full text-muted-foreground hover:text-primary cursor-pointer transition-colors" title="Retry sending this email">
                        <RotateCcw className="h-4 w-4" />
                      </button>
                    )}
                    <button type="button" onClick={() => { onOpenFollowUp({ recipientEmail: se.recipient_email, contactName: se.contact_name, originalSubject: se.subject, originalSentAt: se.scheduled_send_at, originalGmailMessageId: `scheduled_${se.id}`, threadId: se.thread_id || `pending_scheduled_${se.id}`, scheduledEmailId: se.id, existingFollowUp: linkedFU || null }); }} className="p-2 rounded-full text-muted-foreground hover:text-tertiary cursor-pointer transition-colors" title="Schedule follow-up">
                      <Clock className="h-4 w-4" />
                    </button>
                    <button type="button" onClick={() => onCancel(se.id)} className="p-2 rounded-full text-muted-foreground hover:text-destructive cursor-pointer transition-colors" title="Cancel scheduled email">
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
