"use client";

import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { UI_EVENTS, onUiEvent, type UnreadChangedDetail } from "@/lib/ui-events";
import { useAuth } from "@/components/auth-provider";
import { useCapabilities } from "@/hooks/use-capabilities";
import { getGmailConnection } from "@/lib/queries";
import type { GmailConnection } from "@/lib/types";

export type AiDraftContext = {
  draftId: number;
  extractedTopic: string;
  topicEvidence: string;
  sourceMeetingDate?: string;
  articleTitle?: string;
  articleSource?: string;
  articleUrl?: string;
};

/** Pre-written follow-up steps that seed the intro follow-up plan without AI (CAR-50 onboarding). */
export type TemplateFollowUp = {
  subject: string;
  bodyHtml: string;
  delayDays: number;
};

type ComposeOptions = {
  to?: string;
  name?: string;
  subject?: string;
  bodyHtml?: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  quotedHtml?: string;
  /** Resume an existing email_drafts row (CAR-127). Autosave updates this id. */
  draftId?: number;
  aiDraftContext?: AiDraftContext;
  isIntro?: boolean;
  contactId?: number;
  templateFollowUps?: TemplateFollowUp[];
};

type ComposeContextValue = {
  isOpen: boolean;
  /** Increments on every openCompose so the modal body can key-remount to a
   *  clean slate instead of hand-resetting ~25 fields (CAR-145 / F23). */
  composeSessionId: number;
  prefillTo: string;
  prefillName: string;
  prefillSubject: string;
  prefillBodyHtml: string;
  replyThreadId: string;
  replyInReplyTo: string;
  replyReferences: string;
  replyQuotedHtml: string;
  aiDraftContext: AiDraftContext | null;
  /** Existing draft id to resume when compose opens (CAR-127). */
  existingDraftId: number | null;
  isIntro: boolean;
  contactId: number;
  templateFollowUps: TemplateFollowUp[] | null;
  gmailConnected: boolean;
  gmailLoading: boolean;
  gmailAddress: string;
  unreadCount: number;
  /** CAR-102: on the free tier the badge counts follow-ups awaiting review, not unread mail. */
  isFreeOutreach: boolean;
  openCompose: (opts?: ComposeOptions) => void;
  closeCompose: () => void;
};

const ComposeContext = createContext<ComposeContextValue>({
  isOpen: false,
  composeSessionId: 0,
  prefillTo: "",
  prefillName: "",
  prefillSubject: "",
  prefillBodyHtml: "",
  replyThreadId: "",
  replyInReplyTo: "",
  replyReferences: "",
  replyQuotedHtml: "",
  aiDraftContext: null,
  existingDraftId: null,
  isIntro: false,
  contactId: 0,
  templateFollowUps: null,
  gmailConnected: false,
  gmailLoading: true,
  gmailAddress: "",
  unreadCount: 0,
  isFreeOutreach: false,
  openCompose: () => {},
  closeCompose: () => {},
});

export function useCompose() {
  return useContext(ComposeContext);
}

export function ComposeEmailProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { can } = useCapabilities();
  // Boolean (not the `can` fn) so the fetch callback stays referentially stable.
  const isFreeOutreach = can("outreach:portal");
  const [gmailConn, setGmailConn] = useState<GmailConnection | null>(null);
  const [gmailLoading, setGmailLoading] = useState(true);
  const [isOpen, setIsOpen] = useState(false);
  const [composeSessionId, setComposeSessionId] = useState(0);
  const [prefillTo, setPrefillTo] = useState("");
  const [prefillName, setPrefillName] = useState("");
  const [prefillSubject, setPrefillSubject] = useState("");
  const [prefillBodyHtml, setPrefillBodyHtml] = useState("");
  const [replyThreadId, setReplyThreadId] = useState("");
  const [replyInReplyTo, setReplyInReplyTo] = useState("");
  const [replyReferences, setReplyReferences] = useState("");
  const [replyQuotedHtml, setReplyQuotedHtml] = useState("");
  const [aiDraftCtx, setAiDraftCtx] = useState<AiDraftContext | null>(null);
  const [existingDraftId, setExistingDraftId] = useState<number | null>(null);
  const [isIntro, setIsIntro] = useState(false);
  const [contactId, setContactId] = useState(0);
  const [templateFollowUps, setTemplateFollowUps] = useState<TemplateFollowUp[] | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    if (!user) return;
    getGmailConnection(user.id)
      .then((conn) => setGmailConn(conn as GmailConnection | null))
      .catch(() => {})
      .finally(() => setGmailLoading(false));
  }, [user]);

  const fetchUnreadCount = useCallback(() => {
    if (!gmailConn) return;
    // Free tier holds no live inbox, so /unread is always 0 — count the follow-ups
    // awaiting the user's confirm-to-send instead (CAR-102).
    const url = isFreeOutreach ? "/api/gmail/follow-ups/awaiting-review" : "/api/gmail/unread";
    fetch(url, { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => setUnreadCount(data.count || 0))
      .catch(() => {});
  }, [gmailConn, isFreeOutreach]);

  useEffect(() => {
    fetchUnreadCount();
  }, [fetchUnreadCount]);

  // Update badge when emails are read or sent
  useEffect(() => {
    const handleUnread = (detail: UnreadChangedDetail | undefined) => {
      const delta = detail?.delta;
      if (typeof delta === "number") {
        setUnreadCount((prev) => Math.max(0, prev + delta));
      }
      // Explicit refetch (fired after API completes): fetch immediately
      // Delta-only events: trust the optimistic delta, skip auto-refetch
      // Generic events (no delta, no refetch): delayed refetch
      if (detail?.refetch) {
        fetchUnreadCount();
      } else if (typeof delta !== "number") {
        setTimeout(fetchUnreadCount, 600);
      }
    };
    const unsubscribers = [
      onUiEvent(UI_EVENTS.unreadChanged, handleUnread),
      onUiEvent(UI_EVENTS.emailSent, () => setTimeout(fetchUnreadCount, 600)),
    ];
    return () => unsubscribers.forEach((off) => off());
  }, [fetchUnreadCount]);

  const openCompose = useCallback((opts?: ComposeOptions) => {
    setPrefillTo(opts?.to || "");
    setPrefillName(opts?.name || "");
    setPrefillSubject(opts?.subject || "");
    setPrefillBodyHtml(opts?.bodyHtml || "");
    setReplyThreadId(opts?.threadId || "");
    setReplyInReplyTo(opts?.inReplyTo || "");
    setReplyReferences(opts?.references || "");
    setReplyQuotedHtml(opts?.quotedHtml || "");
    setAiDraftCtx(opts?.aiDraftContext || null);
    setExistingDraftId(opts?.draftId ?? null);
    setIsIntro(opts?.isIntro || false);
    setContactId(opts?.contactId || 0);
    setTemplateFollowUps(opts?.templateFollowUps?.length ? opts.templateFollowUps : null);
    // New session id on every open (even open-while-open) so the modal body
    // remounts fresh — no stale field can leak from a previous recipient.
    setComposeSessionId((n) => n + 1);
    setIsOpen(true);
  }, []);

  const closeCompose = useCallback(() => {
    setIsOpen(false);
    setPrefillTo("");
    setPrefillName("");
    setPrefillSubject("");
    setPrefillBodyHtml("");
    setReplyThreadId("");
    setReplyInReplyTo("");
    setReplyReferences("");
    setReplyQuotedHtml("");
    setAiDraftCtx(null);
    setExistingDraftId(null);
    setIsIntro(false);
    setContactId(0);
    setTemplateFollowUps(null);
  }, []);

  return (
    <ComposeContext.Provider
      value={{
        isOpen,
        composeSessionId,
        prefillTo,
        prefillName,
        prefillSubject,
        prefillBodyHtml,
        replyThreadId,
        replyInReplyTo,
        replyReferences,
        replyQuotedHtml,
        aiDraftContext: aiDraftCtx,
        existingDraftId,
        isIntro,
        contactId,
        templateFollowUps,
        // CAR-100: connected == the Gmail send scope was actually granted, not
        // just that a connection row exists (the row is shared with Calendar, so
        // a Calendar-only grant would otherwise read as "Gmail connected").
        gmailConnected: !!gmailConn && gmailConn.send_scope_granted,
        gmailLoading,
        gmailAddress: gmailConn?.gmail_address || "",
        unreadCount,
        isFreeOutreach,
        openCompose,
        closeCompose,
      }}
    >
      {children}
    </ComposeContext.Provider>
  );
}
