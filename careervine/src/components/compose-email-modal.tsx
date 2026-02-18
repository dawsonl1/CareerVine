"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useCompose } from "@/components/compose-email-context";
import { RichTextEditor } from "@/components/ui/rich-text-editor";
import { Button } from "@/components/ui/button";
import { X, ChevronDown, ChevronUp, Send, Check, Reply, Clock } from "lucide-react";
import { AiWriteDropdown } from "@/components/ai-write-dropdown";
import { AvailabilityPicker } from "@/components/availability-picker";

const inputClasses =
  "w-full h-10 px-3 bg-transparent text-foreground text-sm placeholder:text-muted-foreground focus:outline-none";

const fieldRowClasses =
  "flex items-center border-b border-outline-variant/50";

function toLocalDatetimeString(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function ComposeEmailModal() {
  const {
    isOpen, prefillTo, prefillName, prefillSubject,
    replyThreadId, replyInReplyTo, replyReferences, replyQuotedHtml,
    gmailAddress, closeCompose,
  } = useCompose();

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
  const [contactSuggestions, setContactSuggestions] = useState<Array<{ id: number; name: string; email: string }>>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedContactName, setSelectedContactName] = useState("");
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
      setBodyHtml("");
      setShowCcBcc(false);
      setShowQuoted(false);
      setSending(false);
      setSent(false);
      setScheduled(false);
      setError("");
      setShowSchedule(false);
      setScheduleDatetime("");
      draftIdRef.current = null;
      sentOrScheduledRef.current = false;
      setContactSuggestions([]);
      setShowSuggestions(false);
      setSelectedContactName(prefillName || "");
      setContactQuery("");
      setTimeout(() => {
        if (prefillTo) {
          // Focus subject if To is pre-filled
        } else {
          toRef.current?.focus();
        }
      }, 100);
    }
  }, [isOpen, prefillTo, prefillName, prefillSubject]);

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
    // If it looks like an email already, don't search
    if (value.includes("@")) {
      setShowSuggestions(false);
      return;
    }
    setContactQuery(value);
    if (contactSearchTimer.current) clearTimeout(contactSearchTimer.current);
    contactSearchTimer.current = setTimeout(() => searchContacts(value), 200);
  };

  const handleSelectContact = (contact: { id: number; name: string; email: string }) => {
    setTo(contact.email);
    setSelectedContactName(contact.name);
    setShowSuggestions(false);
    setContactSuggestions([]);
    // Also set prefillName equivalent for AI write
  };

  // Close suggestions on outside click
  useEffect(() => {
    if (!showSuggestions) return;
    const handler = (e: MouseEvent) => {
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showSuggestions]);

  // Auto-save draft on content change (debounced 2s)
  useEffect(() => {
    if (!isOpen || sent || scheduled) return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      saveDraft({ to, cc, bcc, subject, bodyHtml });
    }, 2000);
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
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
      window.dispatchEvent(new CustomEvent("careervine:email-sent"));
      setTimeout(() => closeCompose(), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send email");
    } finally {
      setSending(false);
    }
  };

  const handleScheduleSend = async () => {
    if (!validate()) return;
    if (!scheduleDatetime) {
      setError("Please select a date and time to send");
      return;
    }

    const sendAt = new Date(scheduleDatetime);
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
        <div className="flex items-center justify-between px-6 pt-5 pb-3">
          <h2 className="text-[22px] leading-7 font-normal text-foreground flex items-center gap-2">
            {isDone
              ? (scheduled ? "Email scheduled" : "Email sent")
              : isReply
              ? <><Reply className="h-5 w-5" /> Reply</>
              : "New message"}
          </h2>
          <button
            type="button"
            onClick={handleClose}
            className="p-2 rounded-full text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {isDone ? (
          <div className="px-6 pb-8 flex flex-col items-center gap-3 py-8">
            <div className="w-12 h-12 rounded-full bg-primary/15 flex items-center justify-center">
              {scheduled ? <Clock className="h-6 w-6 text-primary" /> : <Check className="h-6 w-6 text-primary" />}
            </div>
            <p className="text-sm text-foreground font-medium">
              {scheduled
                ? `Scheduled for ${new Date(scheduleDatetime).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
                : "Your email has been sent"}
            </p>
          </div>
        ) : (
          <>
            {/* From */}
            <div className={fieldRowClasses}>
              <span className="text-xs text-muted-foreground pl-4 w-12 shrink-0">From</span>
              <span className="text-sm text-muted-foreground px-3 py-2.5">{gmailAddress}</span>
            </div>

            {/* To — with contact autocomplete */}
            <div className={`${fieldRowClasses} relative`}>
              <label className="text-xs text-muted-foreground pl-4 w-12 shrink-0" htmlFor="compose-to">To</label>
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
                  <span className="absolute right-0 top-1/2 -translate-y-1/2 text-[11px] text-primary font-medium pr-1">
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
                        className="w-full text-left px-3 py-2 flex items-center gap-3 hover:bg-primary/[0.06] transition-colors cursor-pointer"
                      >
                        <div className="w-7 h-7 rounded-full bg-primary-container flex items-center justify-center text-on-primary-container text-xs font-medium shrink-0">
                          {c.name[0]?.toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">{c.name}</p>
                          <p className="text-[11px] text-muted-foreground truncate">{c.email}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setShowCcBcc(!showCcBcc)}
                className="pr-4 text-muted-foreground hover:text-foreground cursor-pointer"
                title={showCcBcc ? "Hide CC/BCC" : "Show CC/BCC"}
              >
                {showCcBcc ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>
            </div>

            {/* CC / BCC */}
            {showCcBcc && (
              <>
                <div className={fieldRowClasses}>
                  <label className="text-xs text-muted-foreground pl-4 w-12 shrink-0" htmlFor="compose-cc">CC</label>
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
                  <label className="text-xs text-muted-foreground pl-4 w-12 shrink-0" htmlFor="compose-bcc">BCC</label>
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
              <label className="text-xs text-muted-foreground pl-4 w-12 shrink-0" htmlFor="compose-subject">Subj</label>
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
            <div className="px-4 pt-2 relative z-10 overflow-visible flex items-center gap-2 flex-wrap">
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
            <div className="flex-1 overflow-y-auto min-h-0 px-4 pt-2">
              <RichTextEditor
                content={bodyHtml}
                onChange={setBodyHtml}
                placeholder={isReply ? "Write your reply…" : "Write your message…"}
              />

              {/* Quoted original message for replies */}
              {isReply && replyQuotedHtml && (
                <div className="mt-2">
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 cursor-pointer transition-colors"
                    onClick={() => setShowQuoted(!showQuoted)}
                  >
                    <ChevronDown className={`h-3 w-3 transition-transform ${showQuoted ? "rotate-180" : ""}`} />
                    {showQuoted ? "Hide" : "Show"} original message
                  </button>
                  {showQuoted && (
                    <div className="mt-1.5 pl-3 border-l-2 border-outline-variant/50">
                      <div
                        className="text-xs text-muted-foreground prose prose-sm max-w-none [&_*]:!text-muted-foreground overflow-auto max-h-48"
                        dangerouslySetInnerHTML={{ __html: replyQuotedHtml }}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Schedule send row */}
            {showSchedule && (
              <div className="px-6 pt-2 pb-1">
                <div className="flex items-center gap-2 p-2.5 rounded-xl bg-tertiary-container/20 border border-tertiary/15">
                  <Clock className="h-4 w-4 text-tertiary shrink-0" />
                  <div className="flex-1 min-w-0">
                    <label className="text-xs font-medium text-foreground block mb-1" htmlFor="schedule-datetime">
                      Send at
                    </label>
                    <input
                      id="schedule-datetime"
                      type="datetime-local"
                      value={scheduleDatetime}
                      min={minDatetime}
                      onChange={(e) => setScheduleDatetime(e.target.value)}
                      className="w-full h-8 px-2 rounded-lg border border-outline bg-surface-container-low text-sm text-foreground focus:outline-none focus:border-primary"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => { setShowSchedule(false); setScheduleDatetime(""); }}
                    className="p-1 rounded-full text-muted-foreground hover:text-foreground cursor-pointer shrink-0"
                    title="Cancel scheduling"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}

            {/* Error */}
            {error && (
              <p className="text-sm text-destructive px-6 pt-2">{error}</p>
            )}

            {/* Footer */}
            <div className="flex items-center justify-between px-6 py-4">
              <Button type="button" variant="text" onClick={() => { deleteDraft(); closeCompose(); }}>
                Discard
              </Button>
              <div className="flex items-center gap-2">
                {!showSchedule ? (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setShowSchedule(true)}
                    >
                      <Clock className="h-4 w-4 mr-1.5" />
                      Schedule
                    </Button>
                    <Button type="button" onClick={handleSendNow} loading={sending}>
                      <Send className="h-4 w-4 mr-2" />
                      Send
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    onClick={handleScheduleSend}
                    loading={sending}
                    disabled={!scheduleDatetime}
                  >
                    <Clock className="h-4 w-4 mr-2" />
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
