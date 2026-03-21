"use client";

import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { useAuth } from "@/components/auth-provider";
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

type ComposeOptions = {
  to?: string;
  name?: string;
  subject?: string;
  bodyHtml?: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  quotedHtml?: string;
  aiDraftContext?: AiDraftContext;
};

type ComposeContextValue = {
  isOpen: boolean;
  prefillTo: string;
  prefillName: string;
  prefillSubject: string;
  prefillBodyHtml: string;
  replyThreadId: string;
  replyInReplyTo: string;
  replyReferences: string;
  replyQuotedHtml: string;
  aiDraftContext: AiDraftContext | null;
  gmailConnected: boolean;
  gmailLoading: boolean;
  gmailAddress: string;
  unreadCount: number;
  openCompose: (opts?: ComposeOptions) => void;
  closeCompose: () => void;
};

const ComposeContext = createContext<ComposeContextValue>({
  isOpen: false,
  prefillTo: "",
  prefillName: "",
  prefillSubject: "",
  prefillBodyHtml: "",
  replyThreadId: "",
  replyInReplyTo: "",
  replyReferences: "",
  replyQuotedHtml: "",
  aiDraftContext: null,
  gmailConnected: false,
  gmailLoading: true,
  gmailAddress: "",
  unreadCount: 0,
  openCompose: () => {},
  closeCompose: () => {},
});

export function useCompose() {
  return useContext(ComposeContext);
}

export function ComposeEmailProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [gmailConn, setGmailConn] = useState<GmailConnection | null>(null);
  const [gmailLoading, setGmailLoading] = useState(true);
  const [isOpen, setIsOpen] = useState(false);
  const [prefillTo, setPrefillTo] = useState("");
  const [prefillName, setPrefillName] = useState("");
  const [prefillSubject, setPrefillSubject] = useState("");
  const [prefillBodyHtml, setPrefillBodyHtml] = useState("");
  const [replyThreadId, setReplyThreadId] = useState("");
  const [replyInReplyTo, setReplyInReplyTo] = useState("");
  const [replyReferences, setReplyReferences] = useState("");
  const [replyQuotedHtml, setReplyQuotedHtml] = useState("");
  const [aiDraftCtx, setAiDraftCtx] = useState<AiDraftContext | null>(null);
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
    fetch("/api/gmail/unread", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => setUnreadCount(data.count || 0))
      .catch(() => {});
  }, [gmailConn]);

  useEffect(() => {
    fetchUnreadCount();
  }, [fetchUnreadCount]);

  // Update badge when emails are read or sent
  useEffect(() => {
    const handleUnread = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      if (typeof detail.delta === "number") {
        setUnreadCount((prev) => Math.max(0, prev + detail.delta));
      }
      // Explicit refetch (fired after API completes): fetch immediately
      // Delta-only events: trust the optimistic delta, skip auto-refetch
      // Generic events (no delta, no refetch): delayed refetch
      if (detail.refetch) {
        fetchUnreadCount();
      } else if (typeof detail.delta !== "number") {
        setTimeout(fetchUnreadCount, 600);
      }
    };
    const handleSent = () => setTimeout(fetchUnreadCount, 600);
    window.addEventListener("careervine:unread-changed", handleUnread);
    window.addEventListener("careervine:email-sent", handleSent);
    return () => {
      window.removeEventListener("careervine:unread-changed", handleUnread);
      window.removeEventListener("careervine:email-sent", handleSent);
    };
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
  }, []);

  return (
    <ComposeContext.Provider
      value={{
        isOpen,
        prefillTo,
        prefillName,
        prefillSubject,
        prefillBodyHtml,
        replyThreadId,
        replyInReplyTo,
        replyReferences,
        replyQuotedHtml,
        aiDraftContext: aiDraftCtx,
        gmailConnected: !!gmailConn,
        gmailLoading,
        gmailAddress: gmailConn?.gmail_address || "",
        unreadCount,
        openCompose,
        closeCompose,
      }}
    >
      {children}
    </ComposeContext.Provider>
  );
}
