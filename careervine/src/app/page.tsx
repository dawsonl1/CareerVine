/**
 * Dashboard page (route: /) — CareerVine hub
 *
 * Redesigned around conversations & follow-ups:
 *   1. Onboarding wizard when user has 0 contacts
 *   2. Action items — pending follow-ups front and center
 *   3. "Reach Out Today" — prioritized contacts to reach out to
 *   4. Relationship Health grid — all contacts color-coded by recency
 *   5. Quick-add contact form
 */

"use client";

import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from "react";
import Link from "next/link";
import { useAuth } from "@/components/auth-provider";
import LandingPage from "@/components/landing-page";
import Navigation from "@/components/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  createContact,
  getActionItems,
  getContactsDueForFollowUp,
  getContactsWithLastTouch,
  updateActionItem,
} from "@/lib/queries";
import type { Database } from "@/lib/database.types";
import {
  UserPlus,
  ArrowRight,
  CheckSquare,
  AlertTriangle,
  Send,
  Users,
  Handshake,
  Bell,
  MessageSquare,
  Sparkles,
  X,
  Loader2,
  Bookmark,
  Check,
  Hourglass,
} from "lucide-react";
import { inputClasses } from "@/lib/form-styles";
import { useQuickCapture } from "@/components/quick-capture-context";
import { useCompose } from "@/components/compose-email-context";
import { useToast } from "@/components/ui/toast";
import { getHealthColor, healthBgColors, healthLabels, healthRingColors, CRITICAL_OVERDUE_DAYS, type HealthColor } from "@/lib/health-helpers";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import type { AiDraftContext } from "@/components/compose-email-context";
import { useSuggestions } from "@/hooks/use-suggestions";

type ActionItem = Database["public"]["Tables"]["follow_up_action_items"]["Row"] & {
  contacts: Database["public"]["Tables"]["contacts"]["Row"];
};

type FollowUpContact = {
  id: number;
  name: string;
  industry: string | null;
  photo_url: string | null;
  follow_up_frequency_days: number;
  last_touch: string | null;
  days_overdue: number;
};

type ContactHealth = {
  id: number;
  name: string;
  industry: string | null;
  photo_url: string | null;
  follow_up_frequency_days: number | null;
  last_touch: string | null;
  days_since_touch: number | null;
};

type AiDraft = {
  id: number;
  contact_id: number;
  recipient_email: string | null;
  subject: string;
  body_html: string;
  reply_thread_id: string | null;
  reply_thread_subject: string | null;
  send_as_reply: boolean;
  extracted_topic: string;
  topic_evidence: string;
  source_meeting_id: number | null;
  article_url: string | null;
  article_title: string | null;
  article_source: string | null;
  contacts: { name: string; photo_url: string | null; industry: string | null } | null;
};

export default function Home() {
  const { user, loading } = useAuth();
  const { open: openQuickCapture } = useQuickCapture();
  const { openCompose, gmailConnected } = useCompose();
  const { toast } = useToast();

  // Quick-add contact form
  const [name, setName] = useState("");
  const [industry, setIndustry] = useState("");
  const [metThrough, setMetThrough] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [quickAddError, setQuickAddError] = useState<string | null>(null);

  // Data
  const [actionItems, setActionItems] = useState<ActionItem[]>([]);
  const [followUps, setFollowUps] = useState<FollowUpContact[]>([]);
  const [contactHealth, setContactHealth] = useState<ContactHealth[]>([]);
  const [dataLoaded, setDataLoaded] = useState(false);

  // AI follow-up drafts
  const [aiDrafts, setAiDrafts] = useState<Map<number, AiDraft>>(new Map());
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatingContactIds, setGeneratingContactIds] = useState<number[]>([]);
  const aiDraftsRef = useRef<Map<number, AiDraft>>(new Map());

  // Smart suggestions
  const { suggestions, loading: suggestionsLoading, save: saveSuggestionRaw, complete: completeSuggestionRaw, dismiss: dismissSuggestion, triggerOnce: triggerSuggestions } = useSuggestions();

  const loadData = useCallback(async () => {
    if (!user) return;
    const results = await Promise.allSettled([
      getActionItems(user.id),
      getContactsDueForFollowUp(user.id),
      getContactsWithLastTouch(user.id),
    ]);

    if (results[0].status === "fulfilled") {
      setActionItems((results[0].value as ActionItem[]).slice(0, 10));
    } else {
      console.error("Failed to load action items:", results[0].reason?.message ?? results[0].reason);
    }

    if (results[1].status === "fulfilled") {
      setFollowUps(results[1].value);
    } else {
      console.error("Failed to load follow-ups:", results[1].reason?.message ?? results[1].reason);
    }

    if (results[2].status === "fulfilled") {
      setContactHealth(results[2].value);
    } else {
      console.error("Failed to load contact health:", results[2].reason?.message ?? results[2].reason);
    }

    setDataLoaded(true);
  }, [user]);

  // Keep ref in sync with state to avoid stale closures
  const updateAiDrafts = useCallback((updater: (prev: Map<number, AiDraft>) => Map<number, AiDraft>) => {
    setAiDrafts((prev) => {
      const next = updater(prev);
      aiDraftsRef.current = next;
      return next;
    });
  }, []);

  // Load pending AI drafts, then generate for due contacts — single consolidated function
  const loadAndGenerateAiDrafts = useCallback(async (dueContacts: FollowUpContact[]) => {
    // 1. Fetch existing pending drafts
    try {
      const res = await fetch("/api/gmail/ai-followups/pending");
      if (res.ok) {
        const data = await res.json();
        const map = new Map<number, AiDraft>();
        for (const d of data.drafts || []) {
          map.set(d.contact_id, d);
        }
        updateAiDrafts(() => map);
      }
    } catch {
      // silent
    }

    // 2. Generate for contacts that don't have a draft yet (read from ref for freshness)
    const candidates = dueContacts
      .filter((c) => !aiDraftsRef.current.has(c.id))
      .slice(0, 3);

    if (candidates.length === 0) return;

    const ids = candidates.map((c) => c.id);
    setIsGenerating(true);
    setGeneratingContactIds(ids);

    try {
      const res = await fetch("/api/gmail/ai-followups/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactIds: ids }),
      });
      if (!res.ok) return;
      const data = await res.json();

      updateAiDrafts((prev) => {
        const next = new Map(prev);
        for (const result of data.results || []) {
          if (result.draft) {
            next.set(result.contactId, result.draft as AiDraft);
          }
        }
        return next;
      });
    } catch {
      // silent
    } finally {
      setIsGenerating(false);
      setGeneratingContactIds([]);
    }
  }, [updateAiDrafts]);

  // Dismiss an AI draft with undo toast
  const dismissDraft = useCallback((draftId: number, contactId: number) => {
    // Capture draft for undo before removing
    const undoDraft = aiDraftsRef.current.get(contactId);

    // Optimistically remove
    updateAiDrafts((prev) => {
      const next = new Map(prev);
      next.delete(contactId);
      return next;
    });

    toast("Draft dismissed", {
      variant: "info",
      duration: 5000,
      actions: [{
        label: "Undo",
        onClick: async () => {
          if (undoDraft) {
            updateAiDrafts((prev) => {
              const next = new Map(prev);
              next.set(contactId, undoDraft);
              return next;
            });
          }
          await fetch(`/api/gmail/ai-followups/${draftId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "pending" }),
          });
        },
      }],
    });

    // Dismiss in DB
    fetch(`/api/gmail/ai-followups/${draftId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "dismissed" }),
    });
  }, [updateAiDrafts, toast]);

  // Open compose modal pre-filled with AI draft
  const reviewDraft = useCallback((draft: AiDraft) => {
    const aiCtx: AiDraftContext = {
      draftId: draft.id,
      extractedTopic: draft.extracted_topic,
      topicEvidence: draft.topic_evidence,
      articleTitle: draft.article_title || undefined,
      articleSource: draft.article_source || undefined,
      articleUrl: draft.article_url || undefined,
    };

    openCompose({
      to: draft.recipient_email || "",
      name: draft.contacts?.name || "",
      subject: draft.subject,
      bodyHtml: draft.body_html,
      threadId: draft.send_as_reply ? (draft.reply_thread_id || undefined) : undefined,
      aiDraftContext: aiCtx,
    });
  }, [openCompose]);

  // Wrap saveSuggestion with toast feedback
  const saveSuggestion = useCallback(async (s: Parameters<typeof saveSuggestionRaw>[0]) => {
    const ok = await saveSuggestionRaw(s);
    if (ok) {
      toast("Saved to action items", {
        variant: "success",
        actions: [{ label: "View", onClick: () => window.location.assign("/action-items") }],
      });
    } else {
      toast("Failed to save suggestion", { variant: "error" });
    }
  }, [saveSuggestionRaw, toast]);

  const completeSuggestion = useCallback(async (s: Parameters<typeof completeSuggestionRaw>[0]) => {
    const ok = await completeSuggestionRaw(s);
    if (ok) {
      toast("Marked as done", { variant: "success" });
    } else {
      toast("Failed to mark as done", { variant: "error" });
    }
  }, [completeSuggestionRaw, toast]);

  // Mark action item as done inline from dashboard
  const markActionDone = useCallback(async (itemId: number) => {
    try {
      await updateActionItem(itemId, { is_completed: true, completed_at: new Date().toISOString() });
      setActionItems((prev) => prev.filter((i) => i.id !== itemId));
      toast("Action item completed", { variant: "success" });
    } catch {
      toast("Failed to complete action item", { variant: "error" });
    }
  }, [toast]);

  useEffect(() => {
    if (user) loadData();
  }, [user, loadData]);

  // Load AI drafts + trigger generation once after data loads
  const hasTriggeredGeneration = useRef(false);
  useEffect(() => {
    if (!dataLoaded || !gmailConnected || hasTriggeredGeneration.current) return;
    if (followUps.length > 0) {
      hasTriggeredGeneration.current = true;
      // Only generate for visible contacts (top 6) to avoid orphaned drafts
      loadAndGenerateAiDrafts(followUps.slice(0, 6));
    }
  }, [dataLoaded, gmailConnected, followUps, loadAndGenerateAiDrafts]);

  // Load smart suggestions once after data loads
  useEffect(() => {
    if (dataLoaded) triggerSuggestions();
  }, [dataLoaded, triggerSuggestions]);

  const handleQuickAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !name.trim()) return;
    setSaving(true);
    setQuickAddError(null);
    try {
      await createContact({
        user_id: user.id,
        name: name.trim(),
        met_through: metThrough.trim() || null,
        industry: industry.trim() || null,
        linkedin_url: null,
        notes: null,
        follow_up_frequency_days: null,
        preferred_contact_method: null,
        preferred_contact_value: null,
        contact_status: null,
        expected_graduation: null,
        location_id: null,
      });
      setName("");
      setIndustry("");
      setMetThrough("");
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      await loadData();
    } catch (e) {
      console.error("Error creating contact:", e);
      setQuickAddError("Failed to add contact. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  // ── Derived data ──

  // Reach Out Today: only contacts with a cadence that are due/overdue
  const reachOutToday = useMemo(() => {
    const items: { id: number; name: string; photo_url: string | null; reason: string; urgency: number }[] = [];

    for (const f of followUps) {
      const reason = !f.last_touch
        ? "Never contacted"
        : f.days_overdue === 0
          ? "Follow-up due today"
          : `Follow-up ${f.days_overdue}d overdue`;
      items.push({ id: f.id, name: f.name, photo_url: f.photo_url, reason, urgency: f.days_overdue });
    }

    return items.slice(0, 6);
  }, [followUps]);

  // Total overdue count (for "View all" link)
  const totalOverdue = followUps.length;

  // Compute color once per contact, then derive stats + sorted grid
  const coloredContacts = useMemo(() =>
    contactHealth.map((c) => ({ ...c, color: getHealthColor(c.days_since_touch, c.follow_up_frequency_days) })),
    [contactHealth],
  );

  const healthStats = useMemo(() => {
    const counts: Record<HealthColor, number> = { green: 0, yellow: 0, orange: 0, red: 0, gray: 0 };
    for (const c of coloredContacts) counts[c.color]++;
    return counts;
  }, [coloredContacts]);

  const sortedHealthGrid = useMemo(() => {
    const order: Record<HealthColor, number> = { red: 0, orange: 1, yellow: 2, green: 3, gray: 4 };
    return [...coloredContacts]
      .sort((a, b) => {
        if (order[a.color] !== order[b.color]) return order[a.color] - order[b.color];
        return a.name.localeCompare(b.name);
      })
      .slice(0, 40);
  }, [coloredContacts]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) return <LandingPage />;

  const isNewUser = dataLoaded && contactHealth.length === 0;

  return (
    <div className="min-h-screen bg-background">
      <Navigation />

      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        {/* Greeting */}
        <div className="mb-10 flex items-start justify-between">
          <div>
            <h1 className="text-[28px] leading-9 font-normal text-foreground">
              Hey, {user?.user_metadata?.first_name || "there"}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {isNewUser
                ? "Welcome to CareerVine — let's grow your network."
                : actionItems.length > 0
                ? "Here's what needs your attention."
                : "You're all caught up."}
            </p>
          </div>
          {!isNewUser && (
            <Button variant="tonal" size="sm" onClick={() => openQuickCapture()}>
              <MessageSquare className="h-4 w-4" /> Log conversation
            </Button>
          )}
        </div>

        {/* ══════════════════════════════════════════════════════
            ONBOARDING — shown when user has 0 contacts
           ══════════════════════════════════════════════════════ */}
        {isNewUser && (
          <div className="space-y-6 mb-10">
            {/* Step 1: Add first contact */}
            <Card variant="outlined" className="overflow-hidden">
              <div className="bg-primary-container/30 px-6 py-4 flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold shrink-0">
                  1
                </div>
                <div>
                  <h2 className="text-base font-medium text-foreground">Add your first contact</h2>
                  <p className="text-xs text-muted-foreground">Save someone from your network — you can add more details later.</p>
                </div>
              </div>
              <CardContent className="p-6">
                <form onSubmit={handleQuickAdd} className="space-y-3">
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className={inputClasses}
                    placeholder="Name *"
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <input
                      type="text"
                      value={industry}
                      onChange={(e) => setIndustry(e.target.value)}
                      className={inputClasses}
                      placeholder="Industry (optional)"
                    />
                    <input
                      type="text"
                      value={metThrough}
                      onChange={(e) => setMetThrough(e.target.value)}
                      className={inputClasses}
                      placeholder="Met at (optional)"
                    />
                  </div>
                  <div className="flex items-center gap-3 pt-1">
                    <Button type="submit" loading={saving}>
                      <UserPlus className="h-[18px] w-[18px]" /> Save contact
                    </Button>
                    {saved && (
                      <span className="text-sm text-primary font-medium animate-pulse">
                        Contact saved!
                      </span>
                    )}
                    {quickAddError && (
                      <span className="text-sm text-red-600">{quickAddError}</span>
                    )}
                  </div>
                </form>
              </CardContent>
            </Card>

            {/* Step 2: Log an interaction */}
            <Card variant="outlined" className="opacity-60">
              <div className="px-6 py-4 flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-outline-variant text-muted-foreground flex items-center justify-center text-sm font-bold shrink-0">
                  2
                </div>
                <div>
                  <h2 className="text-base font-medium text-foreground">Log your first interaction</h2>
                  <p className="text-xs text-muted-foreground">Record a coffee chat, email, or phone call with a contact.</p>
                </div>
                <Handshake className="h-5 w-5 text-muted-foreground ml-auto shrink-0" />
              </div>
            </Card>

            {/* Step 3: Set a follow-up */}
            <Card variant="outlined" className="opacity-60">
              <div className="px-6 py-4 flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-outline-variant text-muted-foreground flex items-center justify-center text-sm font-bold shrink-0">
                  3
                </div>
                <div>
                  <h2 className="text-base font-medium text-foreground">Set a follow-up reminder</h2>
                  <p className="text-xs text-muted-foreground">Never lose touch — set a reminder to check in regularly.</p>
                </div>
                <Bell className="h-5 w-5 text-muted-foreground ml-auto shrink-0" />
              </div>
            </Card>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════
            ACTIVE DASHBOARD — shown when user has contacts
           ══════════════════════════════════════════════════════ */}
        {!isNewUser && dataLoaded && (
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-8">
            {/* ── LEFT COLUMN: Actions ── */}
            <div>
            {/* ── Action items (front and center) ── */}
            {(() => {
              const myItems = actionItems.filter((i) => (i as any).direction !== "waiting_on");
              const waitingCount = actionItems.filter((i) => (i as any).direction === "waiting_on").length;
              return (
                <div className="mb-10">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <CheckSquare className="h-5 w-5 text-primary" />
                      <h2 className="text-base font-medium text-foreground">Pending follow-ups</h2>
                      {myItems.length > 0 && (
                        <span className="text-xs text-muted-foreground">
                          {myItems.length} item{myItems.length !== 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                    <Link
                      href="/action-items"
                      className="text-sm font-medium text-primary flex items-center gap-0.5 hover:underline"
                    >
                      View all <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </div>

                  {myItems.length === 0 ? (
                    <Card variant="filled" className="text-center py-8">
                      <CardContent>
                        <CheckSquare className="mx-auto h-8 w-8 text-muted-foreground/40 mb-2" />
                        <p className="text-sm text-muted-foreground">No pending action items</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          Action items created from meetings will appear here.
                        </p>
                      </CardContent>
                    </Card>
                  ) : (
                    <div className="space-y-1.5">
                      {myItems.map((item) => {
                        const today = new Date().toISOString().split("T")[0];
                        const overdue = item.due_at && item.due_at.split("T")[0] < today;
                        const contactId = item.contacts?.id ?? (item as any).action_item_contacts?.[0]?.contact_id;
                        const contactName = item.contacts?.name ?? (item as any).action_item_contacts?.[0]?.contacts?.name;
                        const href = contactId ? `/contacts/${contactId}` : "/action-items";
                        return (
                          <Card
                            key={item.id}
                            variant="outlined"
                            className={`${overdue ? "border-destructive/40" : ""}`}
                          >
                            <CardContent className="p-4 flex items-center gap-3">
                              <button
                                type="button"
                                onClick={() => markActionDone(item.id)}
                                className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 cursor-pointer transition-colors group ${
                                  overdue
                                    ? "bg-error-container hover:bg-green-100 dark:hover:bg-green-900/30"
                                    : "bg-primary-container hover:bg-green-100 dark:hover:bg-green-900/30"
                                }`}
                                title="Mark as done"
                              >
                                <Check className="h-[18px] w-[18px] hidden group-hover:block text-green-600" />
                                {overdue ? (
                                  <AlertTriangle className="h-[18px] w-[18px] text-on-error-container group-hover:hidden" />
                                ) : (
                                  <CheckSquare className="h-[18px] w-[18px] text-on-primary-container group-hover:hidden" />
                                )}
                              </button>
                              <Link href={href} className="flex-1 min-w-0">
                                <p className="text-[15px] font-medium text-foreground truncate">
                                  {item.title}
                                </p>
                                <p className="text-xs text-muted-foreground truncate">
                                  {contactName}
                                  {item.due_at &&
                                    ` · ${overdue ? "Overdue" : "Due"}: ${new Date(
                                      item.due_at
                                    ).toLocaleDateString()}`}
                                </p>
                              </Link>
                            </CardContent>
                          </Card>
                        );
                      })}
                    </div>
                  )}

                  {/* Waiting on indicator */}
                  {waitingCount > 0 && (
                    <Link
                      href="/action-items"
                      className="flex items-center gap-2 mt-3 text-sm text-amber-600 dark:text-amber-400 hover:underline"
                    >
                      <Hourglass className="h-4 w-4" />
                      Waiting on {waitingCount} response{waitingCount !== 1 ? "s" : ""}
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  )}
                </div>
              );
            })()}

            {/* ── Reach Out Today ── */}
            {reachOutToday.length > 0 && (
              <div className="mb-10">
                <div className="flex items-center gap-2 mb-3">
                  <Send className="h-5 w-5 text-primary" />
                  <h2 className="text-base font-medium text-foreground">Reach out today</h2>
                  <span className="text-xs text-muted-foreground ml-1">
                    {reachOutToday.length} {reachOutToday.length === 1 ? "contact" : "contacts"} need attention
                  </span>
                </div>
                <div className="space-y-1.5">
                  {reachOutToday.map((item) => {
                    const isCritical = item.urgency > CRITICAL_OVERDUE_DAYS;
                    const draft = aiDrafts.get(item.id);
                    const isContactGenerating = generatingContactIds.includes(item.id);
                    return (
                      <Fragment key={item.id}>
                        <Link href={`/contacts/${item.id}`}>
                          <Card
                            variant="outlined"
                            className={`state-layer ${isCritical ? "border-destructive/40" : ""}`}
                          >
                            <CardContent className="p-4 flex items-center gap-3">
                              <ContactAvatar
                                name={item.name}
                                photoUrl={item.photo_url}
                                className="w-12 h-12 text-sm"
                                ringClassName={
                                  isCritical
                                    ? healthRingColors.red
                                    : item.urgency > 0
                                    ? healthRingColors.orange
                                    : ""
                                }
                              />
                              <div className="flex-1 min-w-0">
                                <p className="text-[15px] font-medium text-foreground truncate">{item.name}</p>
                                <p className="text-sm text-muted-foreground truncate">{item.reason}</p>
                              </div>
                              <button
                                type="button"
                                onClick={(e) => { e.preventDefault(); openQuickCapture(item.id); }}
                                className="p-2 rounded-full text-primary hover:bg-primary-container transition-colors cursor-pointer shrink-0"
                                title="Log interaction"
                              >
                                <MessageSquare className="h-4 w-4" />
                              </button>
                              {isCritical && (
                                <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
                              )}
                            </CardContent>
                          </Card>
                        </Link>

                        {/* AI Draft inline card */}
                        {draft && (
                          <div className="ml-6 mt-1 mb-1.5">
                            <Card variant="filled" className="border border-primary/10 bg-primary-container/15">
                              <CardContent className="p-3">
                                <div className="flex items-start gap-2">
                                  <Sparkles className="h-3.5 w-3.5 text-primary mt-0.5 shrink-0" />
                                  <div className="flex-1 min-w-0">
                                    <p className="text-xs font-medium text-foreground mb-0.5">
                                      Draft ready
                                    </p>
                                    <p className="text-xs text-muted-foreground truncate">
                                      {draft.body_html.replace(/<[^>]*>/g, "").slice(0, 100)}...
                                    </p>
                                    <p className="text-[10px] text-muted-foreground mt-1">
                                      Based on: {draft.extracted_topic}
                                    </p>
                                  </div>
                                </div>
                                <div className="flex items-center gap-2 mt-2">
                                  <Button
                                    size="sm"
                                    variant="tonal"
                                    onClick={(e) => { e.preventDefault(); reviewDraft(draft); }}
                                  >
                                    Review & Send
                                  </Button>
                                  <button
                                    type="button"
                                    onClick={(e) => { e.preventDefault(); dismissDraft(draft.id, draft.contact_id); }}
                                    className="p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-container-highest transition-colors"
                                    title="Dismiss draft"
                                  >
                                    <X className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </CardContent>
                            </Card>
                          </div>
                        )}

                        {/* Generating indicator */}
                        {isContactGenerating && !draft && (
                          <div className="ml-6 mt-1 mb-1.5 flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Generating draft...
                          </div>
                        )}
                      </Fragment>
                    );
                  })}
                </div>
                {totalOverdue > 6 && (
                  <Link
                    href="/contacts"
                    className="flex items-center gap-0.5 mt-3 text-xs font-medium text-primary hover:underline"
                  >
                    View all {totalOverdue} overdue <ArrowRight className="h-3 w-3" />
                  </Link>
                )}
              </div>
            )}

            {/* ── Suggested Outreach ── */}
            {(suggestionsLoading || suggestions.length > 0) && (
              <div className="mb-10">
                <div className="flex items-center gap-2 mb-3">
                  <Sparkles className="h-5 w-5 text-primary" />
                  <h2 className="text-base font-medium text-foreground">Suggested outreach</h2>
                </div>

                {suggestionsLoading ? (
                  <div className="space-y-1.5">
                    {[1, 2, 3].map((i) => (
                      <div key={i} className="h-20 rounded-[12px] bg-surface-container-highest animate-pulse" />
                    ))}
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {suggestions.map((s) => (
                      <Card key={s.id} variant="outlined" className="border-primary/10">
                        <CardContent className="p-4">
                          <div className="flex items-start gap-3">
                            <ContactAvatar
                              name={s.contactName}
                              photoUrl={s.contactPhotoUrl}
                              className="w-10 h-10 text-sm shrink-0"
                            />
                            <div className="flex-1 min-w-0">
                              <p className="text-[15px] font-medium text-foreground truncate">{s.headline}</p>
                              <p className="text-sm text-muted-foreground truncate">{s.suggestedTitle}</p>
                              <p className="text-xs text-muted-foreground mt-0.5">
                                {s.daysSinceContact !== null ? `${s.daysSinceContact}d since last contact` : "Never contacted"}
                              </p>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                type="button"
                                onClick={() => completeSuggestion(s)}
                                className="p-2 rounded-full text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors cursor-pointer"
                                title="I already did this"
                              >
                                <Check className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => saveSuggestion(s)}
                                className="p-2 rounded-full text-primary hover:bg-primary-container transition-colors cursor-pointer"
                                title="Save for later"
                              >
                                <Bookmark className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => dismissSuggestion(s)}
                                className="p-2 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-container-highest transition-colors cursor-pointer"
                                title="Not interested"
                              >
                                <X className="h-4 w-4" />
                              </button>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── Quick-add contact ── */}
            <Card variant="outlined" className="mb-10">
              <CardContent className="p-6">
                <div className="flex items-center gap-3 mb-5">
                  <div className="w-10 h-10 rounded-full bg-primary-container flex items-center justify-center">
                    <UserPlus className="h-5 w-5 text-on-primary-container" />
                  </div>
                  <div>
                    <h2 className="text-base font-medium text-foreground">Add a contact</h2>
                    <p className="text-xs text-muted-foreground">
                      Save someone you just met — you can fill in more details later.
                    </p>
                  </div>
                </div>

                <form onSubmit={handleQuickAdd} className="space-y-3">
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className={inputClasses}
                    placeholder="Name *"
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <input
                      type="text"
                      value={industry}
                      onChange={(e) => setIndustry(e.target.value)}
                      className={inputClasses}
                      placeholder="Industry (optional)"
                    />
                    <input
                      type="text"
                      value={metThrough}
                      onChange={(e) => setMetThrough(e.target.value)}
                      className={inputClasses}
                      placeholder="Met at (optional)"
                    />
                  </div>
                  <div className="flex items-center gap-3 pt-1">
                    <Button type="submit" loading={saving}>
                      <UserPlus className="h-[18px] w-[18px]" /> Save contact
                    </Button>
                    {saved && (
                      <span className="text-sm text-primary font-medium animate-pulse">
                        Contact saved!
                      </span>
                    )}
                    {quickAddError && (
                      <span className="text-sm text-red-600">{quickAddError}</span>
                    )}
                  </div>
                </form>
              </CardContent>
            </Card>

            </div>{/* end left column */}

            {/* ── RIGHT COLUMN: Network Health ── */}
            <div className="lg:sticky lg:top-6 lg:self-start">
              {contactHealth.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Users className="h-5 w-5 text-primary" />
                      <h2 className="text-base font-medium text-foreground">Network health</h2>
                    </div>
                    <Link
                      href="/contacts"
                      className="text-sm font-medium text-primary flex items-center gap-0.5 hover:underline"
                    >
                      View all <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </div>

                  {/* Health summary bar */}
                  <div className="flex gap-3 mb-4">
                    {(["green", "yellow", "orange", "red", "gray"] as const)
                      .filter((color) => healthStats[color] > 0)
                      .map((color) => (
                        <div key={color} className="flex items-center gap-1.5">
                          <div className={`w-3.5 h-3.5 rounded-full ${healthBgColors[color]}`} />
                          <span className="text-sm text-muted-foreground">
                            {healthStats[color]}
                          </span>
                        </div>
                      ))}
                  </div>

                  {/* Contact grid */}
                  <div className="flex flex-wrap gap-2.5">
                    {sortedHealthGrid.map((c) => (
                      <Link key={c.id} href={`/contacts/${c.id}`} title={`${c.name} — ${
                        c.days_since_touch === null
                          ? "Never contacted"
                          : c.days_since_touch === 0
                          ? "Contacted today"
                          : `${c.days_since_touch}d since last contact`
                      }`}>
                        <ContactAvatar
                          name={c.name}
                          photoUrl={c.photo_url}
                          className="w-12 h-12 text-sm transition-all hover:scale-110 cursor-pointer"
                          ringClassName={healthRingColors[c.color]}
                        />
                      </Link>
                    ))}
                  </div>

                  {/* Legend */}
                  <div className="flex flex-wrap gap-x-4 gap-y-1 mt-4">
                    {(["green", "yellow", "orange", "red", "gray"] as const).map((color) => (
                      <span key={color} className="text-xs text-muted-foreground flex items-center gap-1.5">
                        <span className={`inline-block w-2.5 h-2.5 rounded-full ${healthBgColors[color]}`} />
                        {healthLabels[color]}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>{/* end right column */}
          </div>
        )}

        {/* Loading skeleton */}
        {!dataLoaded && (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 rounded-[12px] bg-surface-container-highest animate-pulse" />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
