"use client";

import { useState, useEffect, useCallback } from "react";
import { RichTextEditor } from "@/components/ui/rich-text-editor";
import { Button } from "@/components/ui/button";
import {
  X, Plus, Clock, Check, AlertCircle, ChevronRight, Pencil, Wand2,
} from "lucide-react";
import type { EmailFollowUp } from "@/lib/types";

export type FollowUpDraft = {
  /** For follow-up #1: days after original email. For #2+: days after previous follow-up. */
  delayDays: number;
  /** Time of day to send, in HH:MM 24h format (e.g. "09:00") */
  sendTime: string;
  subject: string;
  bodyHtml: string;
};

export type FollowUpModalProps = {
  isOpen: boolean;
  onClose: () => void;
  recipientEmail: string;
  contactName: string | null;
  originalSubject: string;
  originalSentAt: string;
  originalGmailMessageId: string;
  threadId: string;
  /** If set, this follow-up is linked to a queued email that hasn't sent yet */
  scheduledEmailId?: number | null;
  /** If provided, the modal opens in edit mode for this existing follow-up */
  existingFollowUp?: EmailFollowUp | null;
};

/**
 * Convert the UI's relative delay model into absolute send_after_days (from original).
 * Follow-up #1: delayDays is days after original email.
 * Follow-up #2+: delayDays is days after the previous follow-up.
 */
function toAbsoluteDays(drafts: FollowUpDraft[]): number[] {
  const result: number[] = [];
  for (let i = 0; i < drafts.length; i++) {
    if (i === 0) {
      result.push(drafts[i].delayDays);
    } else {
      result.push(result[i - 1] + drafts[i].delayDays);
    }
  }
  return result;
}

/**
 * Convert absolute send_after_days back to UI relative delays.
 */
function toRelativeDelays(absoluteDays: number[]): number[] {
  const result: number[] = [];
  for (let i = 0; i < absoluteDays.length; i++) {
    if (i === 0) {
      result.push(absoluteDays[i]);
    } else {
      result.push(absoluteDays[i] - absoluteDays[i - 1]);
    }
  }
  return result;
}

export function FollowUpModal({
  isOpen,
  onClose,
  recipientEmail,
  contactName,
  originalSubject,
  originalSentAt,
  originalGmailMessageId,
  threadId,
  scheduledEmailId,
  existingFollowUp,
}: FollowUpModalProps) {
  const [drafts, setDrafts] = useState<FollowUpDraft[]>([]);
  const [activeTab, setActiveTab] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [generatingAi, setGeneratingAi] = useState(false);

  const isEditing = !!existingFollowUp;

  const daysSinceOriginal = Math.max(
    0,
    Math.floor((Date.now() - new Date(originalSentAt).getTime()) / 86400_000)
  );

  const minDaysForFirst = daysSinceOriginal + 1;

  useEffect(() => {
    if (!isOpen) return;

    if (existingFollowUp) {
      // Edit mode — populate from existing data (only pending messages are editable)
      const msgs = [...existingFollowUp.email_follow_up_messages]
        .filter((m) => m.status === "pending")
        .sort((a, b) => a.sequence_number - b.sequence_number);

      if (msgs.length === 0) {
        setDrafts([]);
        return;
      }

      const absoluteDays = msgs.map((m) => m.send_after_days);
      const relativeDelays = toRelativeDelays(absoluteDays);

      setDrafts(
        msgs.map((m, i) => ({
          delayDays: relativeDelays[i],
          sendTime: "09:00",
          subject: m.subject,
          bodyHtml: m.body_html,
        }))
      );
    } else {
      // New mode
      const defaultDays = Math.max(minDaysForFirst, 3);
      const reSubj = originalSubject.replace(/^(Re:\s*)+/i, "");
      setDrafts([
        {
          delayDays: defaultDays,
          sendTime: "09:00",
          subject: `Re: ${reSubj}`,
          bodyHtml: "",
        },
      ]);
    }

    setActiveTab(0);
    setSaving(false);
    setSaved(false);
    setError("");
  }, [isOpen, existingFollowUp, originalSubject, minDaysForFirst]);

  const updateDraft = useCallback(
    (index: number, updates: Partial<FollowUpDraft>) => {
      setDrafts((prev) => {
        const next = [...prev];
        next[index] = { ...next[index], ...updates };
        return next;
      });
    },
    []
  );

  const addFollowUp = () => {
    const reSubj = originalSubject.replace(/^(Re:\s*)+/i, "");
    setDrafts((prev) => [
      ...prev,
      {
        delayDays: 3,
        sendTime: "09:00",
        subject: `Re: ${reSubj}`,
        bodyHtml: "",
      },
    ]);
    setActiveTab(drafts.length);
  };

  const removeFollowUp = (index: number) => {
    if (drafts.length <= 1) return;
    setDrafts((prev) => prev.filter((_, i) => i !== index));
    setActiveTab((prev) => Math.min(prev, drafts.length - 2));
  };

  const getMinDelay = (index: number): number => {
    if (index === 0) return minDaysForFirst;
    return 1;
  };

  const absoluteDays = toAbsoluteDays(drafts);

  const getScheduledDate = (index: number): Date => {
    const d = new Date(originalSentAt);
    d.setDate(d.getDate() + absoluteDays[index]);
    return d;
  };

  const handleSave = async () => {
    for (let i = 0; i < drafts.length; i++) {
      const d = drafts[i];
      const minDelay = getMinDelay(i);
      if (d.delayDays < minDelay) {
        const label = i === 0 ? "days after the original email" : "days after the previous follow-up";
        setError(`Follow-up ${i + 1}: must be at least ${minDelay} ${label}`);
        setActiveTab(i);
        return;
      }
      if (!d.subject.trim()) {
        setError(`Follow-up ${i + 1}: subject is required`);
        setActiveTab(i);
        return;
      }
      if (!d.bodyHtml.trim() || d.bodyHtml === "<p></p>") {
        setError(`Follow-up ${i + 1}: message body is required`);
        setActiveTab(i);
        return;
      }
    }

    setError("");
    setSaving(true);

    try {
      const absDays = toAbsoluteDays(drafts);

      if (isEditing) {
        // Update existing follow-up
        const res = await fetch(`/api/gmail/follow-ups/${existingFollowUp!.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: drafts.map((d, i) => ({
              sendAfterDays: absDays[i],
              sendTime: d.sendTime,
              subject: d.subject,
              bodyHtml: d.bodyHtml,
            })),
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
      } else {
        // Create new follow-up
        const res = await fetch("/api/gmail/follow-ups", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            originalGmailMessageId,
            threadId,
            recipientEmail,
            contactName,
            originalSubject,
            originalSentAt,
            scheduledEmailId: scheduledEmailId || undefined,
            messages: drafts.map((d, i) => ({
              sendAfterDays: absDays[i],
              sendTime: d.sendTime,
              subject: d.subject,
              bodyHtml: d.bodyHtml,
            })),
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
      }

      setSaved(true);
      setTimeout(() => onClose(), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save follow-ups");
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const currentDraft = drafts[activeTab];
  if (!currentDraft) return null;

  const scheduledDate = getScheduledDate(activeTab);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/32" onClick={onClose} />

      <div className="relative w-full max-w-2xl bg-surface-container-high rounded-[28px] shadow-lg flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-7 pt-6 pb-4">
          <h2 className="text-2xl leading-8 font-normal text-foreground flex items-center gap-2.5">
            {saved ? (
              isEditing ? "Follow-ups updated" : "Follow-ups scheduled"
            ) : (
              <>
                {isEditing ? <Pencil className="h-6 w-6" /> : <Clock className="h-6 w-6" />}
                {isEditing ? "Edit" : "Schedule"} Follow-up{drafts.length > 1 ? "s" : ""}
              </>
            )}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-full text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        {saved ? (
          <div className="px-7 pb-8 flex flex-col items-center gap-4 py-8">
            <div className="w-14 h-14 rounded-full bg-primary/15 flex items-center justify-center">
              <Check className="h-7 w-7 text-primary" />
            </div>
            <p className="text-base text-foreground font-medium">
              {drafts.length} follow-up{drafts.length !== 1 ? "s" : ""} {isEditing ? "updated" : "scheduled"}
            </p>
            <p className="text-sm text-muted-foreground text-center max-w-xs">
              They will be automatically cancelled if {contactName || recipientEmail} replies to the thread.
            </p>
          </div>
        ) : (
          <>
            {/* Auto-cancel notice */}
            <div className="mx-7 mb-4 p-4 rounded-xl bg-tertiary-container/30 border border-tertiary/20">
              <div className="flex items-start gap-2.5">
                <AlertCircle className="h-5 w-5 text-tertiary shrink-0 mt-0.5" />
                <div className="text-sm text-on-tertiary-container">
                  <p className="font-medium">Auto-cancel on reply</p>
                  <p className="mt-1 text-muted-foreground text-sm">
                    If {contactName || recipientEmail} responds to this thread, all pending follow-ups will be automatically cancelled. The system checks for replies before each send.
                  </p>
                </div>
              </div>
            </div>

            {/* Context */}
            <div className="px-7 pb-2.5 text-sm text-muted-foreground space-y-1">
              <p><span className="font-medium">To:</span> {recipientEmail}</p>
              <p><span className="font-medium">Original:</span> {originalSubject}</p>
              <p><span className="font-medium">Sent:</span> {new Date(originalSentAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} ({daysSinceOriginal} day{daysSinceOriginal !== 1 ? "s" : ""} ago)</p>
            </div>

            {/* Tabs */}
            <div className="flex items-center gap-1.5 px-7 pt-2.5 pb-1.5 overflow-x-auto">
              {drafts.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setActiveTab(i)}
                  className={`relative px-4 py-2 rounded-full text-sm font-medium cursor-pointer transition-colors shrink-0 ${
                    activeTab === i
                      ? "bg-primary text-primary-foreground"
                      : "bg-surface-container-low text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Follow-up {i + 1}
                  {drafts.length > 1 && activeTab === i && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeFollowUp(i);
                      }}
                      className="ml-2 inline-flex items-center justify-center w-4 h-4 rounded-full hover:bg-primary-foreground/20 cursor-pointer"
                      title="Remove this follow-up"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </button>
              ))}
              <button
                type="button"
                onClick={addFollowUp}
                className="px-3 py-2 rounded-full text-sm text-primary hover:bg-primary/10 cursor-pointer transition-colors flex items-center gap-1.5 shrink-0"
              >
                <Plus className="h-3.5 w-3.5" />
                Add
              </button>
            </div>

            {/* Active tab content */}
            <div className="flex-1 overflow-y-auto min-h-0 px-7 pt-2.5 pb-4 space-y-4">
              {/* Days + time selector */}
              <div>
                <label className="text-sm font-medium text-foreground block mb-2">
                  Send after
                </label>
                <div className="flex items-center gap-2.5 flex-wrap">
                  <input
                    type="number"
                    min={getMinDelay(activeTab)}
                    value={currentDraft.delayDays}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      if (!isNaN(val)) updateDraft(activeTab, { delayDays: val });
                    }}
                    className="w-20 h-10 px-3 rounded-lg border border-outline bg-surface-container-low text-base text-foreground focus:outline-none focus:border-primary"
                  />
                  <span className="text-base text-muted-foreground">
                    {activeTab === 0 ? "days after original email" : "days after previous follow-up"}
                  </span>
                  <span className="text-base text-muted-foreground">at</span>
                  <input
                    type="time"
                    value={currentDraft.sendTime}
                    onChange={(e) => updateDraft(activeTab, { sendTime: e.target.value })}
                    className="h-10 px-3 rounded-lg border border-outline bg-surface-container-low text-base text-foreground focus:outline-none focus:border-primary"
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-1.5 flex items-center gap-1.5">
                  <ChevronRight className="h-3.5 w-3.5" />
                  Will send on {scheduledDate.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
                  {" "}at {currentDraft.sendTime}
                  {" "}(day {absoluteDays[activeTab]} from original)
                  {currentDraft.delayDays < getMinDelay(activeTab) && (
                    <span className="text-destructive ml-1">
                      (minimum {getMinDelay(activeTab)})
                    </span>
                  )}
                </p>
              </div>

              {/* Subject */}
              <div>
                <label className="text-sm font-medium text-foreground block mb-2" htmlFor={`fu-subject-${activeTab}`}>
                  Subject
                </label>
                <input
                  id={`fu-subject-${activeTab}`}
                  type="text"
                  value={currentDraft.subject}
                  onChange={(e) => updateDraft(activeTab, { subject: e.target.value })}
                  className="w-full h-10 px-4 rounded-lg border border-outline bg-surface-container-low text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                  placeholder="Subject"
                />
              </div>

              {/* Body */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium text-foreground">
                    Message
                  </label>
                  <button
                    type="button"
                    disabled={generatingAi}
                    onClick={async () => {
                      setGeneratingAi(true);
                      try {
                        const res = await fetch("/api/gmail/ai-write", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            recipientEmail,
                            recipientName: contactName || undefined,
                            prompt: `Write follow-up #${activeTab + 1} for an email with subject "${originalSubject}". This is a professional networking follow-up. Keep it brief (2-3 sentences), friendly, and add value. Do not start with "I hope this email finds you well".`,
                          }),
                        });
                        const data = await res.json();
                        if (data.body) {
                          updateDraft(activeTab, { bodyHtml: data.body });
                          if (data.subject && !currentDraft.bodyHtml.trim()) {
                            updateDraft(activeTab, { subject: data.subject });
                          }
                        }
                      } catch {}
                      setGeneratingAi(false);
                    }}
                    className="inline-flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {generatingAi ? (
                      <div className="animate-spin rounded-full h-3.5 w-3.5 border border-primary border-t-transparent" />
                    ) : (
                      <Wand2 className="h-3.5 w-3.5" />
                    )}
                    {generatingAi ? "Generating…" : "Write with AI"}
                  </button>
                </div>
                <RichTextEditor
                  key={`fu-editor-${activeTab}-${isEditing ? "edit" : "new"}`}
                  content={currentDraft.bodyHtml}
                  onChange={(html) => updateDraft(activeTab, { bodyHtml: html })}
                  placeholder={`Write your follow-up message to ${contactName || recipientEmail}…`}
                />
              </div>
            </div>

            {/* Summary strip for multiple follow-ups */}
            {drafts.length > 1 && (
              <div className="px-7 py-2.5 border-t border-outline-variant/50">
                <p className="text-xs text-muted-foreground font-medium mb-1.5">
                  Schedule summary
                </p>
                <div className="flex flex-wrap gap-2.5">
                  {drafts.map((d, i) => (
                    <span
                      key={i}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs ${
                        activeTab === i
                          ? "bg-primary/15 text-primary font-medium"
                          : "bg-surface-container-low text-muted-foreground"
                      }`}
                    >
                      #{i + 1}: {i === 0 ? `Day ${absoluteDays[i]}` : `+${d.delayDays}d (Day ${absoluteDays[i]})`}
                      {d.bodyHtml && d.bodyHtml !== "<p></p>" ? (
                        <Check className="h-3 w-3 text-primary" />
                      ) : (
                        <span className="text-destructive">*</span>
                      )}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Error */}
            {error && (
              <p className="text-base text-destructive px-7 pt-1">{error}</p>
            )}

            {/* Footer */}
            <div className="flex items-center justify-end gap-4 px-7 py-5">
              <Button type="button" variant="text" onClick={onClose}>
                Cancel
              </Button>
              <Button type="button" onClick={handleSave} loading={saving}>
                {isEditing ? <Pencil className="h-5 w-5 mr-2" /> : <Clock className="h-5 w-5 mr-2" />}
                {isEditing ? "Update" : "Schedule"} {drafts.length} follow-up{drafts.length !== 1 ? "s" : ""}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
