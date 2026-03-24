/**
 * Home page — CareerVine hub
 *
 * Three-band layout:
 *   Band 1: Greeting + Log conversation button
 *   Band 2: Unified action list (left) + Today's schedule + New contacts (right)
 *   Band 3: Your Networking — stats, heatmap, donut, neglected contacts, trend
 */

"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useAuth } from "@/components/auth-provider";
import LandingPage from "@/components/landing-page";
import Navigation from "@/components/navigation";
import {
  getActionItems,
  getContactsDueForFollowUp,
  getContactsWithLastTouch,
  getRecentUncontactedContacts,
  getActionListCounts,
  getHomeStats,
  getActivityHeatmap,
  getNetworkHealthSummary,
  getNeglectedContacts,
  updateActionItem,
  snoozeActionItem,
  snoozeContact,
  skipContactFirstOutreach,
  setSuggestionCooldown,
} from "@/lib/queries";
import type { Database } from "@/lib/database.types";
import { useQuickCapture } from "@/components/quick-capture-context";
import { useCompose } from "@/components/compose-email-context";
import { useToast } from "@/components/ui/toast";
import { useSuggestions } from "@/hooks/use-suggestions";
import { useGmailConnection } from "@/hooks/use-gmail-connection";

import { LogConversationFab } from "@/components/home/log-conversation-fab";
import { UnifiedActionList, type UnifiedActionItem, type SnoozeAction } from "@/components/home/unified-action-list";
import { TodaySchedule, type ScheduleEvent } from "@/components/home/today-schedule";
import { type NewContact } from "@/components/home/new-contacts";
import { NetworkingStats } from "@/components/home/networking-stats";

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
  never_contacted: boolean;
  emails: string[];
};

export default function Home() {
  const { user, loading } = useAuth();
  const { open: openQuickCapture } = useQuickCapture();
  const { openCompose } = useCompose();
  const { toast } = useToast();
  const { calendarConnected } = useGmailConnection();

  // ── Data state ──
  const [actionItems, setActionItems] = useState<ActionItem[]>([]);
  const [followUps, setFollowUps] = useState<FollowUpContact[]>([]);
  const [contactHealth, setContactHealth] = useState<{ id: number; name: string; days_since_touch: number | null; follow_up_frequency_days: number | null }[]>([]);
  const [dataLoaded, setDataLoaded] = useState(false);

  // Band 2 right data
  const [scheduleEvents, setScheduleEvents] = useState<ScheduleEvent[]>([]);
  const [scheduleLoading, setScheduleLoading] = useState(true);
  const [newContacts, setNewContacts] = useState<NewContact[]>([]);

  // Band 3 data
  const [homeStats, setHomeStats] = useState<Awaited<ReturnType<typeof getHomeStats>> | null>(null);
  const [heatmapData, setHeatmapData] = useState<{ date: string; count: number; dayOfWeek: number }[]>([]);
  const [healthSummary, setHealthSummary] = useState<Awaited<ReturnType<typeof getNetworkHealthSummary>> | null>(null);
  const [neglectedContacts, setNeglectedContactsList] = useState<Awaited<ReturnType<typeof getNeglectedContacts>>>([]);
  const [band3Loading, setBand3Loading] = useState(true);

  // Calendar height prediction from fast count query
  // >= 3 items: assume 5 visible rows (suggestions will fill gaps). Never resize.
  // < 3 items: predict small, then measure once after core data loads.
  const [predictedListHeight, setPredictedListHeight] = useState(0);
  const [predictedCountLow, setPredictedCountLow] = useState(false); // true if count < 3
  const leftColRef = useRef<HTMLDivElement>(null);
  const [measuredListHeight, setMeasuredListHeight] = useState(0);

  // Only measure once after core data loads, and only if count was low
  useEffect(() => {
    if (!predictedCountLow || !dataLoaded || !leftColRef.current) return;
    // Measure once, then stop
    setMeasuredListHeight(leftColRef.current.clientHeight);
  }, [predictedCountLow, dataLoaded]);

  const calendarAvailableHeight = predictedCountLow && measuredListHeight > 0
    ? measuredListHeight
    : predictedListHeight;

  // Suggestions
  const {
    suggestions,
    loading: suggestionsLoading,
    save: saveSuggestionRaw,
    complete: completeSuggestionRaw,
    dismiss: dismissSuggestion,
    triggerOnce: triggerSuggestions,
  } = useSuggestions();

  // ── Data loading ──

  const loadCoreData = useCallback(async () => {
    if (!user) return;
    const results = await Promise.allSettled([
      getActionItems(user.id),
      getContactsDueForFollowUp(user.id),
      getContactsWithLastTouch(user.id),
      getRecentUncontactedContacts(user.id),
    ]);

    if (results[0].status === "fulfilled") setActionItems((results[0].value as ActionItem[]).slice(0, 15));
    if (results[1].status === "fulfilled") setFollowUps(results[1].value);
    if (results[2].status === "fulfilled") setContactHealth(results[2].value);
    if (results[3].status === "fulfilled") {
      setNewContacts(
        results[3].value.map((c) => ({
          id: c.id,
          name: c.name,
          photo_url: c.photo_url,
          emails: c.emails,
          created_at: c.created_at ?? null,
        }))
      );
    }

    setDataLoaded(true);
  }, [user]);

  const loadSchedule = useCallback(async () => {
    if (!user || !calendarConnected) {
      setScheduleLoading(false);
      return;
    }
    try {
      const today = new Date();
      const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
      const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59).toISOString();
      const res = await fetch(`/api/calendar/events?start=${encodeURIComponent(startOfDay)}&end=${encodeURIComponent(endOfDay)}`);
      if (res.ok) {
        const data = await res.json();
        // TODO: match attendees to known contacts for prep context
        setScheduleEvents(
          (data.events || []).map((e: { id: number; title: string | null; start_at: string; end_at: string }) => ({
            id: e.id,
            title: e.title,
            start_at: e.start_at,
            end_at: e.end_at,
          }))
        );
      }
    } catch {
      // silent
    } finally {
      setScheduleLoading(false);
    }
  }, [user, calendarConnected]);

  const loadBand3 = useCallback(async () => {
    if (!user) return;
    try {
      const results = await Promise.allSettled([
        getHomeStats(user.id),
        getActivityHeatmap(user.id),
        getNetworkHealthSummary(user.id),
        getNeglectedContacts(user.id),
      ]);

      if (results[0].status === "fulfilled") setHomeStats(results[0].value);
      if (results[1].status === "fulfilled") setHeatmapData(results[1].value);
      if (results[2].status === "fulfilled") setHealthSummary(results[2].value);
      if (results[3].status === "fulfilled") setNeglectedContactsList(results[3].value);
    } catch {
      // silent
    } finally {
      setBand3Loading(false);
    }
  }, [user]);

  // Predict action list height from fast counts — fires first so calendar sizes correctly
  const loadCounts = useCallback(async () => {
    if (!user) return;
    try {
      const counts = await getActionListCounts(user.id);
      const totalItems = counts.actionItems + counts.reachOut + counts.recentlyAdded;

      if (totalItems < 3) {
        // Few items — predict with +2 buffer, then measure once after core data loads
        setPredictedCountLow(true);
        const visibleRows = totalItems + 2;
        const height = 48 + 48 + visibleRows * 104;
        setPredictedListHeight(height);
      } else {
        // 3+ items: assume 5 visible rows (suggestions fill gaps, or paginated at 5)
        const height = 48 + 48 + 5 * 104 + (totalItems > 5 ? 40 : 0);
        setPredictedListHeight(height);
      }
    } catch {
      // silent — calendar will just use minimum range
    }
  }, [user]);

  useEffect(() => {
    if (user) {
      // Fire count query first, then everything else in parallel
      loadCounts();
      loadCoreData();
      loadSchedule();
      loadBand3();
    }
  }, [user, loadCounts, loadCoreData, loadSchedule, loadBand3]);

  // Refresh when a conversation is logged
  useEffect(() => {
    const handler = () => {
      loadCoreData();
      loadBand3();
    };
    window.addEventListener("careervine:conversation-logged", handler);
    return () => window.removeEventListener("careervine:conversation-logged", handler);
  }, [loadCoreData, loadBand3]);

  // Load suggestions once after data loads
  useEffect(() => {
    if (dataLoaded) triggerSuggestions();
  }, [dataLoaded, triggerSuggestions]);

  // ── Action handlers ──

  const markActionDone = useCallback(
    async (itemId: number) => {
      try {
        await updateActionItem(itemId, { is_completed: true, completed_at: new Date().toISOString() });
        setActionItems((prev) => prev.filter((i) => i.id !== itemId));
        toast("Action item completed", { variant: "success" });
      } catch {
        toast("Failed to complete action item", { variant: "error" });
      }
    },
    [toast]
  );

  const saveSuggestion = useCallback(
    async (s: Parameters<typeof saveSuggestionRaw>[0]) => {
      const ok = await saveSuggestionRaw(s);
      if (ok) {
        toast("Saved to action items", { variant: "success" });
        loadCoreData();
      } else {
        toast("Failed to save", { variant: "error" });
      }
    },
    [saveSuggestionRaw, toast, loadCoreData]
  );

  const completeSuggestion = useCallback(
    async (s: Parameters<typeof completeSuggestionRaw>[0]) => {
      const ok = await completeSuggestionRaw(s);
      if (ok) toast("Marked as done", { variant: "success" });
      else toast("Failed to mark as done", { variant: "error" });
    },
    [completeSuggestionRaw, toast]
  );

  // ── Build unified action list ──

  // Build last-touch lookup from contactHealth
  const lastTouchLookup = useMemo(() => {
    const map = new Map<number, number | null>();
    for (const c of contactHealth) map.set(c.id, c.days_since_touch);
    return map;
  }, [contactHealth]);

  function formatLastContacted(daysSince: number | null): string {
    if (daysSince === null) return "Never contacted";
    if (daysSince === 0) return "Contacted today";
    if (daysSince === 1) return "1 day ago";
    return `${daysSince}d ago`;
  }

  const unifiedItems = useMemo<UnifiedActionItem[]>(() => {
    const items: UnifiedActionItem[] = [];

    // Action items
    const today = new Date().toISOString().split("T")[0];
    for (const ai of actionItems) {
      if (ai.direction === "waiting_on") continue;
      const isOverdue = ai.due_at ? ai.due_at.split("T")[0] < today : false;
      const dueLabel = ai.due_at
        ? isOverdue
          ? `Overdue · Due ${new Date(ai.due_at).toLocaleDateString()}`
          : `Due ${new Date(ai.due_at).toLocaleDateString()}`
        : "No due date";
      const contactName = ai.contacts?.name || "Unknown";
      const contactId = ai.contacts?.id || 0;
      const daysSince = lastTouchLookup.get(contactId) ?? null;

      items.push({
        id: `ai-${ai.id}`,
        type: "action_item",
        contactId,
        contactName,
        contactPhotoUrl: ai.contacts?.photo_url || null,
        primaryText: `${ai.title} · ${dueLabel}`,
        secondaryText: ai.description || "",
        lastContactedLabel: formatLastContacted(daysSince),
        priority: isOverdue ? 100 : ai.due_at ? 50 : 10,
        actionItemId: ai.id,
        dueAt: ai.due_at || undefined,
        isOverdue,
      });
    }

    // Reach out contacts
    for (const f of followUps) {
      const daysSince = f.last_touch
        ? Math.floor((Date.now() - new Date(f.last_touch).getTime()) / (1000 * 60 * 60 * 24))
        : null;

      let primaryText: string;
      if (f.never_contacted) {
        primaryText = f.days_overdue > 0
          ? `Send first message · ${f.days_overdue}d overdue`
          : "Send first message · Due today";
      } else {
        primaryText = f.days_overdue > 0 ? `${f.days_overdue}d overdue` : "Due today";
      }

      items.push({
        id: `ro-${f.id}`,
        type: "reach_out",
        contactId: f.id,
        contactName: f.name,
        contactPhotoUrl: f.photo_url,
        primaryText,
        secondaryText: "",
        lastContactedLabel: f.never_contacted ? "Never contacted" : formatLastContacted(daysSince),
        priority: 60 + Math.min(f.days_overdue, 30),
        daysOverdue: f.days_overdue,
        hasEmail: f.emails.length > 0,
      });
    }

    // AI suggestions
    for (const s of suggestions) {
      items.push({
        id: `sg-${s.id}`,
        type: "suggestion",
        contactId: s.contactId,
        contactName: s.contactName,
        contactPhotoUrl: s.contactPhotoUrl,
        primaryText: s.headline,
        secondaryText: s.suggestedTitle,
        lastContactedLabel: formatLastContacted(s.daysSinceContact),
        priority: 5 + s.score / 10,
        daysSinceContact: s.daysSinceContact,
        suggestion: s,
      });
    }

    // Recently added contacts
    for (const nc of newContacts) {
      const daysAgo = nc.created_at
        ? Math.floor((Date.now() - new Date(nc.created_at).getTime()) / (1000 * 60 * 60 * 24))
        : 0;
      const addedLabel = daysAgo === 0 ? "Added today" : daysAgo === 1 ? "Added yesterday" : `Added ${daysAgo}d ago`;
      items.push({
        id: `nc-${nc.id}`,
        type: "recently_added",
        contactId: nc.id,
        contactName: nc.name,
        contactPhotoUrl: nc.photo_url,
        primaryText: addedLabel,
        secondaryText: "",
        lastContactedLabel: "Never contacted",
        priority: 30, // Below urgent action items & reach out, above suggestions
        hasEmail: nc.emails.length > 0,
      });
    }

    items.sort((a, b) => b.priority - a.priority);

    return items;
  }, [actionItems, followUps, suggestions, newContacts, lastTouchLookup]);

  // ── Unified action list callbacks ──

  const handleComplete = useCallback(
    (item: UnifiedActionItem) => {
      if (item.type === "action_item" && item.actionItemId) {
        markActionDone(item.actionItemId);
      } else if (item.type === "reach_out") {
        openQuickCapture(item.contactId);
      } else if (item.type === "suggestion" && item.suggestion) {
        completeSuggestion(item.suggestion);
      }
    },
    [markActionDone, openQuickCapture, completeSuggestion]
  );

  const handleSnooze = useCallback(
    async (item: UnifiedActionItem, action: SnoozeAction) => {
      try {
        if (action.type === "skip_contact") {
          // Recently Added → permanent skip
          await skipContactFirstOutreach(item.contactId);
          setNewContacts((prev) => prev.filter((c) => c.id !== item.contactId));
          toast("Contact skipped", { variant: "info" });
          return;
        }

        // Calculate snooze-until timestamp
        let until: string;
        let label: string;

        if (action.type === "until_next_followup") {
          if (item.type === "action_item" && item.dueAt) {
            until = item.dueAt;
          } else {
            // For reach out / suggestion: use the contact's follow-up frequency
            const contact = followUps.find((f) => f.id === item.contactId);
            const freqDays = contact?.follow_up_frequency_days || 30;
            const nextDue = new Date();
            nextDue.setDate(nextDue.getDate() + freqDays);
            until = nextDue.toISOString();
          }
          label = "Snoozed until next follow-up";
        } else {
          const snoozeDate = new Date();
          snoozeDate.setDate(snoozeDate.getDate() + action.days);
          until = snoozeDate.toISOString();
          label = `Snoozed for ${action.days} day${action.days > 1 ? "s" : ""}`;
        }

        if (item.type === "action_item" && item.actionItemId) {
          await snoozeActionItem(item.actionItemId, until);
          setActionItems((prev) => prev.filter((i) => i.id !== item.actionItemId));
        } else if (item.type === "reach_out") {
          await snoozeContact(item.contactId, until);
          setFollowUps((prev) => prev.filter((f) => f.id !== item.contactId));
        } else if (item.type === "recently_added") {
          await snoozeContact(item.contactId, until);
          setNewContacts((prev) => prev.filter((c) => c.id !== item.contactId));
        } else if (item.type === "suggestion" && item.suggestion) {
          // Save the suggestion as an action item, then snooze it
          const ok = await saveSuggestionRaw(item.suggestion);
          if (ok) {
            await setSuggestionCooldown(item.contactId);
          }
          dismissSuggestion(item.suggestion);
        }

        toast(label, { variant: "info" });
      } catch {
        toast("Failed to snooze", { variant: "error" });
      }
    },
    [toast, followUps, saveSuggestionRaw, dismissSuggestion]
  );

  const handleDismiss = useCallback(
    async (item: UnifiedActionItem) => {
      if (item.suggestion) {
        dismissSuggestion(item.suggestion);
        await setSuggestionCooldown(item.contactId);
      }
    },
    [dismissSuggestion]
  );

  const handleSave = useCallback(
    (item: UnifiedActionItem) => {
      if (item.suggestion) saveSuggestion(item.suggestion);
    },
    [saveSuggestion]
  );

  const handleLogInteraction = useCallback(
    (contactId: number) => openQuickCapture(contactId),
    [openQuickCapture]
  );

  const handleDraftEmail = useCallback(
    (contactId: number) => {
      const contact = followUps.find((f) => f.id === contactId);
      if (contact) {
        const email = contact.emails[0] || "";
        openCompose({
          to: email,
          name: contact.name,
          subject: "",
          bodyHtml: "",
          isIntro: contact.never_contacted,
        });
      }
    },
    [followUps, openCompose]
  );

  // ── New contacts handlers ──

  const handleNewContactNote = useCallback(
    (contactId: number) => {
      // Navigate to contact page for now
      window.location.assign(`/contacts/${contactId}`);
    },
    []
  );

  const handleNewContactIntro = useCallback(
    (contactId: number) => {
      const contact = newContacts.find((c) => c.id === contactId);
      if (!contact) return;
      const email = contact.emails[0] || "";
      openCompose({
        to: email,
        name: contact.name,
        subject: "",
        bodyHtml: "",
        isIntro: true,
      });
    },
    [newContacts, openCompose]
  );

  // ── Render ──

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
  const isEmpty = isNewUser && actionItems.length === 0 && followUps.length === 0 && suggestions.length === 0;

  return (
    <div className="min-h-screen bg-background">
      <Navigation />

      <LogConversationFab onClick={() => openQuickCapture()} />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        {/* ═══ Band 2: Workspace ═══ */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-8 mb-12">
          {/* Left: Unified action list */}
          <div ref={leftColRef}>
            <UnifiedActionList
              items={unifiedItems}
              loading={!dataLoaded || suggestionsLoading}
              onComplete={handleComplete}
              onSnooze={handleSnooze}
              onDismiss={handleDismiss}
              onSave={handleSave}
              onLogInteraction={handleLogInteraction}
              onDraftEmail={handleDraftEmail}
              onNote={handleNewContactNote}
              onIntro={handleNewContactIntro}
              isEmpty={isEmpty}
              onLogConversation={() => openQuickCapture()}
              calendarConnected={calendarConnected}
            />
          </div>

          {/* Right: Schedule */}
          <div>
            <TodaySchedule
              events={scheduleEvents}
              loading={scheduleLoading}
              calendarConnected={calendarConnected}
              availableHeight={calendarAvailableHeight}
            />
          </div>
        </div>

        {/* ═══ Band 3: Reflection ═══ */}
        {dataLoaded && !isNewUser && (
          <NetworkingStats
            stats={homeStats}
            heatmapData={heatmapData}
            healthSummary={healthSummary}
            neglectedContacts={neglectedContacts}
            loading={band3Loading}
          />
        )}
      </main>
    </div>
  );
}
