"use client";

import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { useAuth } from "@/components/auth-provider";
import { getGmailConnection } from "@/lib/queries";
import type { GmailConnection } from "@/lib/types";

type ComposeOptions = {
  to?: string;
  name?: string;
  subject?: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  quotedHtml?: string;
};

type ComposeContextValue = {
  isOpen: boolean;
  prefillTo: string;
  prefillName: string;
  prefillSubject: string;
  replyThreadId: string;
  replyInReplyTo: string;
  replyReferences: string;
  replyQuotedHtml: string;
  gmailConnected: boolean;
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
  replyThreadId: "",
  replyInReplyTo: "",
  replyReferences: "",
  replyQuotedHtml: "",
  gmailConnected: false,
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
  const [isOpen, setIsOpen] = useState(false);
  const [prefillTo, setPrefillTo] = useState("");
  const [prefillName, setPrefillName] = useState("");
  const [prefillSubject, setPrefillSubject] = useState("");
  const [replyThreadId, setReplyThreadId] = useState("");
  const [replyInReplyTo, setReplyInReplyTo] = useState("");
  const [replyReferences, setReplyReferences] = useState("");
  const [replyQuotedHtml, setReplyQuotedHtml] = useState("");
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    if (!user) return;
    getGmailConnection(user.id)
      .then((conn) => setGmailConn(conn as GmailConnection | null))
      .catch(() => {});
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
    setReplyThreadId(opts?.threadId || "");
    setReplyInReplyTo(opts?.inReplyTo || "");
    setReplyReferences(opts?.references || "");
    setReplyQuotedHtml(opts?.quotedHtml || "");
    setIsOpen(true);
  }, []);

  const closeCompose = useCallback(() => {
    setIsOpen(false);
    setPrefillTo("");
    setPrefillName("");
    setPrefillSubject("");
    setReplyThreadId("");
    setReplyInReplyTo("");
    setReplyReferences("");
    setReplyQuotedHtml("");
  }, []);

  return (
    <ComposeContext.Provider
      value={{
        isOpen,
        prefillTo,
        prefillName,
        prefillSubject,
        replyThreadId,
        replyInReplyTo,
        replyReferences,
        replyQuotedHtml,
        gmailConnected: !!gmailConn,
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
