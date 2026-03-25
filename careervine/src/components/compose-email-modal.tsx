"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useClickOutside } from "@/hooks/use-click-outside";
import DOMPurify from "dompurify";
import { useCompose } from "@/components/compose-email-context";
import { useOnboarding } from "@/components/onboarding/onboarding-provider";
import { ONBOARDING_CONTACT_EMAIL } from "@/components/onboarding/onboarding-steps";
import { RichTextEditor } from "@/components/ui/rich-text-editor";
import { Button } from "@/components/ui/button";
import { X, ChevronDown, ChevronUp, Send, Check, Reply, Clock, Sparkles } from "lucide-react";
import { AiWriteDropdown } from "@/components/ai-write-dropdown";
import { AvailabilityPicker } from "@/components/availability-picker";
import { IntroContextForm } from "@/components/intro-context-form";
import { FollowUpPlanSection, type FollowUpDraft } from "@/components/follow-up-plan-section";

type IntroPhase = "context" | "generating" | "editing" | "generating-followups" | "ready";

function formatProjectedDate(delayDays: number, fromDate = new Date()): string {
  const sendDate = new Date(fromDate.getTime() + delayDays * 24 * 60 * 60 * 1000);
  sendDate.setHours(9, 5, 0, 0);
  return sendDate.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
  }) + " \u00b7 9:05 AM";
}

const inputClasses =
  "w-full h-11 px-4 bg-transparent text-foreground text-base placeholder:text-muted-foreground focus:outline-none";

const fieldRowClasses =
  "flex items-center border-b border-outline-variant/50";

function toLocalDatetimeString(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function ComposeEmailModal() {
  const {
    isOpen, prefillTo, prefillName, prefillSubject, prefillBodyHtml,
    replyThreadId, replyInReplyTo, replyReferences, replyQuotedHtml,
    aiDraftContext, isIntro, contactId, gmailAddress, closeCompose,
  } = useCompose();

  const [showAiContext, setShowAiContext] = useState(false);
  const [introPhase, setIntroPhase] = useState<IntroPhase>("context");

  // Follow-up plan state (intro flow only)
  const [followUps, setFollowUps] = useState<FollowUpDraft[]>([]);
  const [followUpsEnabled, setFollowUpsEnabled] = useState(true);
  const [followUpError, setFollowUpError] = useState<string | null>(null);
  const [introError, setIntroError] = useState<string | null>(null);
  const introContextRef = useRef<{ howMet: string; goal: string }>({ howMet: "", goal: "" });

  const { advanceIfStep } = useOnboarding();

  const isReply = !!replyThreadId;

  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [showQuoted, setShowQuoted] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [scheduled, setScheduled] = useState(false);
  const [error, setError] = useState("");

  // Schedule send state
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleDatetime, setScheduleDatetime] = useState("");

  const toRef = useRef<HTMLInputElement>(null);
  const draftIdRef = useRef<number | null>(null);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentOrScheduledRef = useRef(false);

  // Contact autocomplete
  const [contactQuery, setContactQuery] = useState("");
  const [contactSuggestions, setContactSuggestions] = useState<Array<{ id: number; name: string; email: string; emails: string[] }>>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedContactName, setSelectedContactName] = useState("");
  const [contactEmailOptions, setContactEmailOptions] = useState<string[]>([]);
  const contactSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // Minimum datetime is 5 minutes from now
  const minDatetime = toLocalDatetimeString(new Date(Date.now() + 5 * 60_000));

  const saveDraft = useCallback(async (fields: { to: string; cc: string; bcc: string; subject: string; bodyHtml: string }) => {
    // Don't save empty drafts
    if (!fields.to.trim() && !fields.subject.trim() && !fields.bodyHtml.trim()) return;
    try {
      const res = await fetch("/api/gmail/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: draftIdRef.current || undefined,
          to: fields.to.trim(),
          cc: fields.cc.trim() || undefined,
          bcc: fields.bcc.trim() || undefined,
          subject: fields.subject.trim(),
          bodyHtml: fields.bodyHtml,
          contactName: prefillName || undefined,
          threadId: replyThreadId || undefined,
          inReplyTo: replyInReplyTo || undefined,
          references: replyReferences || undefined,
        }),
      });
      const data = await res.json();
      if (data.draft?.id) draftIdRef.current = data.draft.id;
      window.dispatchEvent(new CustomEvent("careervine:drafts-changed"));
    } catch {
      // silent — draft save is best-effort
    }
  }, [prefillName, replyThreadId, replyInReplyTo, replyReferences]);

  const deleteDraft = useCallback(async () => {
    if (!draftIdRef.current) return;
    try {
      await fetch(`/api/gmail/drafts/${draftIdRef.current}`, { method: "DELETE" });
      draftIdRef.current = null;
      window.dispatchEvent(new CustomEvent("careervine:drafts-changed"));
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      setTo(prefillTo);
      setCc("");
      setBcc("");
      setSubject(prefillSubject || (prefillName ? `Hi ${prefillName}` : ""));
      setBodyHtml(prefillBodyHtml || "");
      setShowCcBcc(false);
      setShowQuoted(false);
      setSending(false);
      setSent(false);
      setScheduled(false);
      setError("");
      setShowSchedule(false);
      setScheduleDatetime("");
      setShowAiContext(false);
      setIntroPhase(isIntro && !prefillBodyHtml ? "context" : "editing");
      setFollowUps([]);
      setFollowUpsEnabled(true);
      setFollowUpError(null);
      setIntroError(null);
      introContextRef.current = { howMet: "", goal: "" };
      draftIdRef.current = null;
      sentOrScheduledRef.current = false;
      setContactSuggestions([]);
      setShowSuggestions(false);
      setSelectedContactName(prefillName || "");
      setContactQuery("");
      setContactEmailOptions([]);
      // Advance onboarding when intro modal opens for Dawson
      if (isIntro && prefillTo?.includes(ONBOARDING_CONTACT_EMAIL)) {
        advanceIfStep("click_intro_button");
      }

      setTimeout(() => {
        if (prefillTo) {
          // Focus subject if To is pre-filled
        } else {
          toRef.current?.focus();
        }
      }, 100);
    }
  }, [isOpen, prefillTo, prefillName, prefillSubject, prefillBodyHtml]);

  // Contact autocomplete: debounced search
  const searchContacts = useCallback(async (query: string) => {
    if (query.length < 1) { setContactSuggestions([]); setShowSuggestions(false); return; }
    try {
      const res = await fetch(`/api/contacts/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      setContactSuggestions(data.contacts || []);
      setShowSuggestions((data.contacts || []).length > 0);
    } catch {
      setContactSuggestions([]);
      setShowSuggestions(false);
    }
  }, []);

  const handleToChange = (value: string) => {
    setTo(value);
    setSelectedContactName("");
    setContactEmailOptions([]);
    // If it looks like an email already, don't search
    if (value.includes("@")) {
      setShowSuggestions(false);
      return;
    }
    setContactQuery(value);
    if (contactSearchTimer.current) clearTimeout(contactSearchTimer.current);
    contactSearchTimer.current = setTimeout(() => searchContacts(value), 200);
  };

  const handleSelectContact = (contact: { id: number; name: string; email: string; emails: string[] }) => {
    setTo(contact.email);
    setSelectedContactName(contact.name);
    setShowSuggestions(false);
    setContactSuggestions([]);
    setContactEmailOptions(contact.emails.length > 1 ? contact.emails : []);
  };

  // Close suggestions on outside click
  useClickOutside(suggestionsRef, useCallback(() => setShowSuggestions(false), []), showSuggestions);

  const [draftSavedVisible, setDraftSavedVisible] = useState(false);
  const draftSavedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-save draft on content change (debounced 2s)
  useEffect(() => {
    if (!isOpen || sent || scheduled) return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(async () => {
      await saveDraft({ to, cc, bcc, subject, bodyHtml });
      if (to.trim() || subject.trim() || bodyHtml.trim()) {
        setDraftSavedVisible(true);
        if (draftSavedTimer.current) clearTimeout(draftSavedTimer.current);
        draftSavedTimer.current = setTimeout(() => setDraftSavedVisible(false), 2000);
      }
    }, 2000);
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      if (draftSavedTimer.current) clearTimeout(draftSavedTimer.current);
    };
  }, [isOpen, to, cc, bcc, subject, bodyHtml, sent, scheduled, saveDraft]);

  const validate = (): boolean => {
    if (!to.trim()) {
      setError("Recipient is required");
      return false;
    }
    if (!subject.trim()) {
      setError("Subject is required");
      return false;
    }
    return true;
  };

  // Create follow-up sequence records after sending the intro
  const createFollowUpRecords = useCallback(async (opts: {
    threadId: string;
    messageId: string;
    scheduledEmailId?: number;
    sendTime: Date;
  }) => {
    if (!isIntro || !followUpsEnabled || followUps.length === 0 || !contactId) return;
    try {
      await fetch("/api/email-follow-ups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactId,
          threadId: opts.threadId || null,
          messageId: opts.messageId || null,
          scheduledEmailId: opts.scheduledEmailId || null,
          recipientEmail: to.trim(),
          contactName: prefillName || null,
          originalSubject: subject.trim(),
          originalSentAt: opts.sendTime.toISOString(),
          timezoneOffsetMinutes: new Date().getTimezoneOffset(),
          followUps: followUps.map((fu) => ({
            subject: fu.subject,
            bodyHtml: fu.bodyHtml,
            delayDays: fu.delayDays,
          })),
        }),
      });
    } catch (err) {
      console.warn("[follow-ups] Failed to create follow-up records:", err);
    }
  }, [isIntro, followUpsEnabled, followUps, contactId, to, prefillName, subject]);

  // Shared follow-up generation logic (used by approve button + retry)
  const generateFollowUps = useCallback(async () => {
    setIntroPhase("generating-followups");
    setFollowUpError(null);
    try {
      const res = await fetch("/api/ai/draft-follow-ups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactId,
          introSubject: subject,
          introBodyHtml: bodyHtml,
          goal: introContextRef.current.goal || undefined,
          howMet: introContextRef.current.howMet || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok && data.followUps) {
        setFollowUps(
          data.followUps.map((fu: any, i: number) => ({
            id: `fu-${i}`,
            subject: fu.subject,
            bodyHtml: fu.bodyHtml,
            delayDays: fu.delayDays,
            projectedDate: formatProjectedDate(fu.delayDays),
          }))
        );
        setIntroPhase("ready");
      } else {
        setFollowUpError(data.error || "Failed to generate follow-ups");
        setIntroPhase("editing");
      }
    } catch {
      setFollowUpError("Failed to generate follow-ups. Try again.");
      setIntroPhase("editing");
    }
  }, [contactId, subject, bodyHtml]);

  const handleSendNow = async () => {
    if (!validate()) return;

    setError("");
    setSending(true);
    try {
      const res = await fetch("/api/gmail/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: to.trim(),
          cc: cc.trim() || undefined,
          bcc: bcc.trim() || undefined,
          subject: subject.trim(),
          bodyHtml,
          ...(replyThreadId ? { threadId: replyThreadId } : {}),
          ...(replyInReplyTo ? { inReplyTo: replyInReplyTo } : {}),
          ...(replyReferences ? { references: replyReferences } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setSent(true);
      sentOrScheduledRef.current = true;
      deleteDraft();

      // Advance onboarding when email sent to Dawson
      if (to.trim().toLowerCase().includes(ONBOARDING_CONTACT_EMAIL)) {
        advanceIfStep("compose_send_email");
      }

      // Create follow-up records for intro emails
      if (data.messageId && data.threadId) {
        createFollowUpRecords({
          threadId: data.threadId,
          messageId: data.messageId,
          sendTime: new Date(),
        });
      }

      // Mark AI draft as sent/edited_and_sent if this came from one
      if (aiDraftContext?.draftId) {
        const draftStatus = bodyHtml !== prefillBodyHtml ? "edited_and_sent" : "sent";
        await fetch(`/api/gmail/ai-followups/${aiDraftContext.draftId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: draftStatus }),
        }).catch((e) => console.warn("[AI Draft] Failed to update draft status:", e));
      }

      window.dispatchEvent(new CustomEvent("careervine:email-sent"));
      setTimeout(() => closeCompose(), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send email");
    } finally {
      setSending(false);
    }
  };

  const handleScheduleSend = async (sendAtOverride?: Date) => {
    if (!validate()) return;
    const sendAt = sendAtOverride || (scheduleDatetime ? new Date(scheduleDatetime) : null);
    if (!sendAt) {
      setError("Please select a date and time to send");
      return;
    }
    if (sendAt.getTime() <= Date.now()) {
      setError("Scheduled time must be in the future");
      return;
    }

    setError("");
    setSending(true);
    try {
      const res = await fetch("/api/gmail/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: to.trim(),
          cc: cc.trim() || undefined,
          bcc: bcc.trim() || undefined,
          subject: subject.trim(),
          bodyHtml,
          scheduledSendAt: sendAt.toISOString(),
          contactName: prefillName || undefined,
          ...(replyThreadId ? { threadId: replyThreadId } : {}),
          ...(replyInReplyTo ? { inReplyTo: replyInReplyTo } : {}),
          ...(replyReferences ? { references: replyReferences } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setScheduled(true);
      sentOrScheduledRef.current = true;
      deleteDraft();

      // Create follow-up records for scheduled intro emails
      if (data.scheduledEmail?.id) {
        createFollowUpRecords({
          threadId: "",
          messageId: "",
          scheduledEmailId: data.scheduledEmail.id,
          sendTime: sendAt,
        });
      }

      // Mark AI draft as sent/edited_and_sent if this came from one
      if (aiDraftContext?.draftId) {
        const draftStatus = bodyHtml !== prefillBodyHtml ? "edited_and_sent" : "sent";
        await fetch(`/api/gmail/ai-followups/${aiDraftContext.draftId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: draftStatus }),
        }).catch((e) => console.warn("[AI Draft] Failed to update draft status:", e));
      }

      window.dispatchEvent(new CustomEvent("careervine:email-sent"));
      setTimeout(() => closeCompose(), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to schedule email");
    } finally {
      setSending(false);
    }
  };

  // Save draft on close if there's content and not sent/scheduled
  const handleClose = useCallback(() => {
    if (!sentOrScheduledRef.current && (to.trim() || subject.trim() || bodyHtml.trim())) {
      saveDraft({ to, cc, bcc, subject, bodyHtml });
    }
    closeCompose();
  }, [to, cc, bcc, subject, bodyHtml, saveDraft, closeCompose]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, handleClose]);

  if (!isOpen) return null;

  const isDone = sent || scheduled;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/32" onClick={handleClose} />

      <div className="relative w-full max-w-2xl bg-surface-container-high rounded-[28px] shadow-lg flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-7 pt-6 pb-4">
          <h2 className="text-2xl leading-8 font-normal text-foreground flex items-center gap-2.5">
            {isDone
              ? (scheduled ? "Email scheduled" : "Email sent")
              : isReply
              ? <><Reply className="h-6 w-6" /> Reply</>
              : "New message"}
          </h2>
          <button
            type="button"
            onClick={handleClose}
            className="p-2.5 rounded-full text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        {isDone ? (
          <div className="px-7 pb-10 flex flex-col items-center gap-4 py-10">
            <div className="w-14 h-14 rounded-full bg-primary/15 flex items-center justify-center">
              {scheduled ? <Clock className="h-7 w-7 text-primary" /> : <Check className="h-7 w-7 text-primary" />}
            </div>
            <p className="text-base text-foreground font-medium">
              {scheduled
                ? `Scheduled for ${new Date(scheduleDatetime).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
                : "Your email has been sent"}
            </p>
          </div>
        ) : (
          <>
            {/* AI Draft Context banner */}
            {aiDraftContext && (
              <div className="mx-5 mt-1 mb-2.5">
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => setShowAiContext(!showAiContext)}
                >
                  <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-primary-container/30 border border-primary/10">
                    <Sparkles className="h-4 w-4 text-primary shrink-0" />
                    <span className="text-sm text-foreground font-medium flex-1 truncate">
                      AI draft — {aiDraftContext.extractedTopic}
                    </span>
                    <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${showAiContext ? "rotate-180" : ""}`} />
                  </div>
                </button>
                {showAiContext && (
                  <div className="mt-2 px-4 py-2.5 rounded-xl bg-surface-container-low text-sm text-muted-foreground space-y-1.5">
                    <p><span className="font-medium text-foreground">Interest:</span> &ldquo;{aiDraftContext.topicEvidence}&rdquo;</p>
                    {aiDraftContext.sourceMeetingDate && (
                      <p><span className="font-medium text-foreground">From:</span> {aiDraftContext.sourceMeetingDate}</p>
                    )}
                    {aiDraftContext.articleTitle && (
                      <p>
                        <span className="font-medium text-foreground">Article:</span> {aiDraftContext.articleTitle}
                        {aiDraftContext.articleSource && ` via ${aiDraftContext.articleSource}`}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* From */}
            <div className={fieldRowClasses}>
              <span className="text-sm text-muted-foreground pl-5 w-14 shrink-0">From</span>
              <span className="text-base text-muted-foreground px-4 py-3">{gmailAddress}</span>
            </div>

            {/* To — with contact autocomplete */}
            <div className={`${fieldRowClasses} relative`}>
              <label className="text-sm text-muted-foreground pl-5 w-14 shrink-0" htmlFor="compose-to">To</label>
              <div className="flex-1 min-w-0 relative">
                <input
                  ref={toRef}
                  id="compose-to"
                  type="text"
                  value={to}
                  onChange={(e) => handleToChange(e.target.value)}
                  onFocus={() => { if (contactSuggestions.length > 0 && !to.includes("@")) setShowSuggestions(true); }}
                  className={inputClasses}
                  placeholder="Name or email…"
                  autoComplete="off"
                />
                {selectedContactName && to.includes("@") && (
                  <span className="absolute right-0 top-1/2 -translate-y-1/2 text-xs text-primary font-medium pr-1.5">
                    {selectedContactName}
                  </span>
                )}
                {showSuggestions && contactSuggestions.length > 0 && (
                  <div
                    ref={suggestionsRef}
                    className="absolute left-0 top-full z-50 w-full bg-surface-container-high rounded-b-xl shadow-lg border border-outline-variant border-t-0 overflow-hidden"
                  >
                    {contactSuggestions.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => handleSelectContact(c)}
                        className="w-full text-left px-4 py-2.5 flex items-center gap-3.5 hover:bg-primary/[0.06] transition-colors cursor-pointer"
                      >
                        <div className="w-8 h-8 rounded-full bg-primary-container flex items-center justify-center text-on-primary-container text-sm font-medium shrink-0">
                          {c.name[0]?.toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-base font-medium text-foreground truncate">{c.name}</p>
                          <p className="text-xs text-muted-foreground truncate">{c.email}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setShowCcBcc(!showCcBcc)}
                className="pr-5 text-muted-foreground hover:text-foreground cursor-pointer"
                title={showCcBcc ? "Hide CC/BCC" : "Show CC/BCC"}
              >
                {showCcBcc ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
              </button>
            </div>

            {/* Multi-email picker — shown when selected contact has >1 email */}
            {contactEmailOptions.length > 1 && (
              <div className="flex items-center gap-2 px-5 py-2 border-b border-outline-variant/50 flex-wrap">
                <span className="text-xs text-muted-foreground shrink-0">Send to:</span>
                {contactEmailOptions.map((email) => (
                  <button
                    key={email}
                    type="button"
                    onClick={() => setTo(email)}
                    className={`text-xs px-2.5 py-0.5 rounded-full transition-colors ${
                      to === email
                        ? "bg-primary text-primary-foreground"
                        : "bg-surface-container-low text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {email}
                  </button>
                ))}
              </div>
            )}

            {/* CC / BCC */}
            {showCcBcc && (
              <>
                <div className={fieldRowClasses}>
                  <label className="text-sm text-muted-foreground pl-5 w-14 shrink-0" htmlFor="compose-cc">CC</label>
                  <input
                    id="compose-cc"
                    type="email"
                    value={cc}
                    onChange={(e) => setCc(e.target.value)}
                    className={inputClasses}
                    placeholder="cc@example.com"
                  />
                </div>
                <div className={fieldRowClasses}>
                  <label className="text-sm text-muted-foreground pl-5 w-14 shrink-0" htmlFor="compose-bcc">BCC</label>
                  <input
                    id="compose-bcc"
                    type="email"
                    value={bcc}
                    onChange={(e) => setBcc(e.target.value)}
                    className={inputClasses}
                    placeholder="bcc@example.com"
                  />
                </div>
              </>
            )}

            {/* Subject */}
            <div className={fieldRowClasses}>
              <label className="text-sm text-muted-foreground pl-5 w-14 shrink-0" htmlFor="compose-subject">Subj</label>
              <input
                id="compose-subject"
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className={inputClasses}
                placeholder="Subject"
              />
            </div>

            {/* Toolbar — AI Write + Insert Availability */}
            <div className="px-5 pt-2.5 relative z-10 overflow-visible flex items-center gap-2.5 flex-wrap">
              <AiWriteDropdown
                recipientEmail={to}
                recipientName={selectedContactName || prefillName}
                existingSubject={subject}
                onGenerated={(body, generatedSubject) => {
                  setBodyHtml(body);
                  if (generatedSubject && !subject.trim()) {
                    setSubject(generatedSubject);
                  }
                }}
              />
              <AvailabilityPicker
                recipientEmail={to.includes("@") ? to.trim() : undefined}
                onInsert={(text) => {
                  setBodyHtml((prev) => {
                    const separator = prev.trim() ? "<br><br>" : "";
                    return prev + separator + text.split("\n").join("<br>");
                  });
                }}
              />
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto min-h-0 px-5 pt-2.5">
              {/* Intro context form — shown when compose opened for intro */}
              {isIntro && (introPhase === "context" || introPhase === "generating") && (
                <IntroContextForm
                  contactName={prefillName || "this contact"}
                  onGenerate={async (ctx) => {
                    setIntroPhase("generating");
                    introContextRef.current = { howMet: ctx.howMet, goal: ctx.goal };
                    try {
                      // Save context to contact
                      if (contactId && (ctx.howMet || ctx.goal)) {
                        fetch(`/api/contacts/${contactId}`, {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            met_through: ctx.howMet || undefined,
                            intro_goal: ctx.goal || undefined,
                          }),
                        }).catch(() => {}); // best-effort save
                      }
                      if (contactId && ctx.notes) {
                        fetch(`/api/contacts/${contactId}/note`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ note: ctx.notes }),
                        }).catch(() => {});
                      }

                      const res = await fetch("/api/ai/draft-intro", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          contactId,
                          howMet: ctx.howMet || undefined,
                          goal: ctx.goal || undefined,
                          notes: ctx.notes || undefined,
                        }),
                      });
                      const data = await res.json();
                      if (res.ok) {
                        setBodyHtml(data.bodyHtml || "");
                        if (data.subject) setSubject(data.subject);
                        setIntroError(null);
                        setIntroPhase("editing");
                      } else {
                        setIntroError(data.error || "Failed to generate email. Please try again.");
                        setIntroPhase("context");
                      }
                    } catch {
                      setIntroError("Failed to generate email. Please try again.");
                      setIntroPhase("context");
                    }
                  }}
                  onSkip={async () => {
                    setIntroPhase("generating");
                    setIntroError(null);
                    try {
                      const res = await fetch("/api/ai/draft-intro", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ contactId }),
                      });
                      const data = await res.json();
                      if (res.ok) {
                        setBodyHtml(data.bodyHtml || "");
                        if (data.subject) setSubject(data.subject);
                        setIntroError(null);
                        setIntroPhase("editing");
                      } else {
                        setIntroError(data.error || "Failed to generate email. Please try again.");
                        setIntroPhase("context");
                      }
                    } catch {
                      setIntroError("Failed to generate email. Please try again.");
                      setIntroPhase("context");
                    }
                  }}
                  generating={introPhase === "generating"}
                  error={introError}
                />
              )}

              <div
                className={`transition-opacity duration-300 ${isIntro && introPhase === "context" ? "opacity-0 h-0 overflow-hidden" : "opacity-100"}`}
              >
                <RichTextEditor
                  content={bodyHtml}
                  onChange={(html) => {
                    setBodyHtml(html);
                  }}
                  placeholder={isReply ? "Write your reply…" : "Write your message…"}
                />
              </div>

              {/* Quoted original message for replies */}
              {isReply && replyQuotedHtml && (
                <div className="mt-2.5">
                  <button
                    type="button"
                    className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1.5 cursor-pointer transition-colors"
                    onClick={() => setShowQuoted(!showQuoted)}
                  >
                    <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showQuoted ? "rotate-180" : ""}`} />
                    {showQuoted ? "Hide" : "Show"} original message
                  </button>
                  {showQuoted && (
                    <div className="mt-2 pl-4 border-l-2 border-outline-variant/50">
                      <div
                        className="text-sm text-muted-foreground prose prose-sm max-w-none [&_*]:!text-muted-foreground overflow-auto max-h-52"
                        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(replyQuotedHtml) }}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Follow-up plan (intro flow) */}
            {isIntro && introPhase !== "context" && introPhase !== "generating" && (
              <div className="px-5">
                {/* Approve & generate follow-ups button */}
                {introPhase === "editing" && (
                  <div className="flex justify-center py-3">
                    <button
                      type="button"
                      onClick={generateFollowUps}
                      className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-primary/10 text-primary text-sm font-medium hover:bg-primary/15 transition-colors cursor-pointer"
                    >
                      <Sparkles className="h-4 w-4" />
                      Approve intro & generate follow-ups
                    </button>
                  </div>
                )}

                <FollowUpPlanSection
                  followUps={followUps}
                  enabled={followUpsEnabled}
                  loading={introPhase === "generating-followups"}
                  error={followUpError}
                  placeholder={introPhase === "editing" && followUps.length === 0}
                  onToggle={setFollowUpsEnabled}
                  onEdit={(id, updates) => {
                    setFollowUps((prev) =>
                      prev.map((fu) => {
                        if (fu.id !== id) return fu;
                        const updated = { ...fu, ...updates };
                        // Recalculate projected date when delay changes
                        if (updates.delayDays && updates.delayDays !== fu.delayDays) {
                          updated.projectedDate = formatProjectedDate(updates.delayDays);
                        }
                        return updated;
                      })
                    );
                  }}
                  onRemove={(id) => {
                    setFollowUps((prev) => prev.filter((fu) => fu.id !== id));
                  }}
                  onRetry={generateFollowUps}
                />
              </div>
            )}

            {/* Schedule send row */}
            {showSchedule && (
              <div className="px-7 pt-2.5 pb-1.5">
                <div className="flex items-center gap-2.5 p-3 rounded-xl bg-tertiary-container/20 border border-tertiary/15">
                  <Clock className="h-5 w-5 text-tertiary shrink-0" />
                  <div className="flex-1 min-w-0">
                    <label className="text-sm font-medium text-foreground block mb-1.5" htmlFor="schedule-datetime">
                      Send at
                    </label>
                    <input
                      id="schedule-datetime"
                      type="datetime-local"
                      value={scheduleDatetime}
                      min={minDatetime}
                      onChange={(e) => setScheduleDatetime(e.target.value)}
                      className="w-full h-9 px-2.5 rounded-lg border border-outline bg-surface-container-low text-base text-foreground focus:outline-none focus:border-primary"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => { setShowSchedule(false); setScheduleDatetime(""); }}
                    className="p-1.5 rounded-full text-muted-foreground hover:text-foreground cursor-pointer shrink-0"
                    title="Cancel scheduling"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}

            {/* Error */}
            {error && (
              <p className="text-base text-destructive px-7 pt-2.5">{error}</p>
            )}

            {/* Footer */}
            <div className="flex items-center justify-between px-7 py-5">
              <div className="flex items-center gap-2.5">
                <Button type="button" variant="text" onClick={() => { deleteDraft(); closeCompose(); }}>
                  Discard
                </Button>
                <Button
                  type="button"
                  variant="text"
                  size="sm"
                  onClick={async () => {
                    await saveDraft({ to, cc, bcc, subject, bodyHtml });
                    closeCompose();
                  }}
                >
                  Save draft
                </Button>
                {draftSavedVisible && (
                  <span className="text-sm text-muted-foreground animate-in fade-in-0 duration-300">
                    <Check className="inline h-3.5 w-3.5 mr-1" />
                    Draft saved
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2.5">
                {!showSchedule ? (
                  <>
                    {isIntro && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const tomorrow = new Date();
                          tomorrow.setDate(tomorrow.getDate() + 1);
                          tomorrow.setHours(9, 5, 0, 0);
                          handleScheduleSend(tomorrow);
                        }}
                        loading={sending}
                      >
                        <Clock className="h-5 w-5 mr-2" />
                        Tomorrow 9:05 AM
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setShowSchedule(true)}
                    >
                      <Clock className="h-5 w-5 mr-2" />
                      Schedule
                    </Button>
                    <Button type="button" onClick={handleSendNow} loading={sending}>
                      <Send className="h-5 w-5 mr-2" />
                      Send
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    onClick={() => handleScheduleSend()}
                    loading={sending}
                    disabled={!scheduleDatetime}
                  >
                    <Clock className="h-5 w-5 mr-2" />
                    Schedule send
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
