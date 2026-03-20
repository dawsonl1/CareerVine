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

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { useAuth } from "@/components/auth-provider";
import AuthForm from "@/components/auth-form";
import Navigation from "@/components/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  createContact,
  getActionItems,
  getContactsDueForFollowUp,
  getContactsWithLastTouch,
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
} from "lucide-react";
import { inputClasses } from "@/lib/form-styles";
import { useQuickCapture } from "@/components/quick-capture-context";

type ActionItem = Database["public"]["Tables"]["follow_up_action_items"]["Row"] & {
  contacts: Database["public"]["Tables"]["contacts"]["Row"];
};

type FollowUpContact = {
  id: number;
  name: string;
  industry: string | null;
  follow_up_frequency_days: number;
  last_touch: string | null;
  days_overdue: number;
};

type ContactHealth = {
  id: number;
  name: string;
  industry: string | null;
  follow_up_frequency_days: number | null;
  last_touch: string | null;
  days_since_touch: number | null;
  created_at: string | null;
};

/**
 * Classify a contact into a health bucket based on days since last touch.
 */
function getHealthColor(daysSince: number | null): "green" | "yellow" | "orange" | "red" {
  if (daysSince === null) return "red"; // never contacted
  if (daysSince <= 14) return "green";
  if (daysSince <= 30) return "yellow";
  if (daysSince <= 60) return "orange";
  return "red";
}

const healthStyles = {
  green: "bg-[#c8e6c9] text-[#1b5e20] ring-[#66bb6a]/30",
  yellow: "bg-[#fff9c4] text-[#f57f17] ring-[#ffee58]/30",
  orange: "bg-[#ffe0b2] text-[#e65100] ring-[#ffa726]/30",
  red: "bg-[#ffcdd2] text-[#b71c1c] ring-[#ef5350]/30",
};

const healthLabels = {
  green: "Active (< 2 weeks)",
  yellow: "Cooling (2-4 weeks)",
  orange: "At risk (1-2 months)",
  red: "Cold (2+ months / never)",
};

export default function Home() {
  const { user, loading } = useAuth();
  const { open: openQuickCapture } = useQuickCapture();

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

  const loadData = useCallback(async () => {
    if (!user) return;
    try {
      const [items, dueContacts, healthData] = await Promise.all([
        getActionItems(user.id),
        getContactsDueForFollowUp(user.id),
        getContactsWithLastTouch(user.id),
      ]);
      setActionItems((items as ActionItem[]).slice(0, 10));
      setFollowUps(dueContacts);
      setContactHealth(healthData);
    } catch (e) {
      console.error("Error loading home data:", e);
    } finally {
      setDataLoaded(true);
    }
  }, [user]);

  useEffect(() => {
    if (user) loadData();
  }, [user, loadData]);

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

  // Reach Out Today: combine overdue follow-ups + stale contacts (60+ days no touch)
  const reachOutToday = useMemo(() => {
    // Start with overdue follow-ups (already sorted by most overdue)
    const items: { id: number; name: string; reason: string; urgency: number }[] = [];
    const seen = new Set<number>();

    for (const f of followUps.slice(0, 8)) {
      seen.add(f.id);
      const reason =
        f.days_overdue === 0
          ? "Follow-up due today"
          : `Follow-up ${f.days_overdue}d overdue`;
      items.push({ id: f.id, name: f.name, reason, urgency: f.days_overdue + 100 });
    }

    // Add stale contacts not already in follow-ups
    for (const c of contactHealth) {
      if (seen.has(c.id)) continue;
      if (c.days_since_touch === null) {
        items.push({ id: c.id, name: c.name, reason: "Never contacted", urgency: 50 });
        seen.add(c.id);
      } else if (c.days_since_touch >= 30) {
        items.push({
          id: c.id,
          name: c.name,
          reason: `Last contact ${c.days_since_touch}d ago`,
          urgency: c.days_since_touch,
        });
        seen.add(c.id);
      }
    }

    return items.sort((a, b) => b.urgency - a.urgency).slice(0, 6);
  }, [followUps, contactHealth]);

  // Health grid stats
  const healthStats = useMemo(() => {
    const counts = { green: 0, yellow: 0, orange: 0, red: 0 };
    for (const c of contactHealth) {
      counts[getHealthColor(c.days_since_touch)]++;
    }
    return counts;
  }, [contactHealth]);

  // Sorted health grid (memoized to avoid re-sorting on every render)
  const sortedHealthGrid = useMemo(() => {
    const order = { red: 0, orange: 1, yellow: 2, green: 3 };
    return [...contactHealth]
      .sort((a, b) => {
        const aColor = getHealthColor(a.days_since_touch);
        const bColor = getHealthColor(b.days_since_touch);
        if (order[aColor] !== order[bColor]) return order[aColor] - order[bColor];
        return a.name.localeCompare(b.name);
      })
      .slice(0, 40);
  }, [contactHealth]);

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

  if (!user) return <AuthForm />;

  const isNewUser = dataLoaded && contactHealth.length === 0;

  return (
    <div className="min-h-screen bg-background">
      <Navigation />

      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
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
          <>
            {/* ── Action items (front and center) ── */}
            <div className="mb-10">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <CheckSquare className="h-4 w-4 text-primary" />
                  <h2 className="text-sm font-medium text-foreground">Pending follow-ups</h2>
                  {actionItems.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {actionItems.length} item{actionItems.length !== 1 ? "s" : ""}
                    </span>
                  )}
                </div>
                <Link
                  href="/action-items"
                  className="text-xs font-medium text-primary flex items-center gap-0.5 hover:underline"
                >
                  View all <ArrowRight className="h-3 w-3" />
                </Link>
              </div>

              {actionItems.length === 0 ? (
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
                  {actionItems.map((item) => {
                    const today = new Date().toISOString().split("T")[0];
                    const overdue = item.due_at && item.due_at.split("T")[0] < today;
                    const contactId = item.contacts?.id ?? (item as any).action_item_contacts?.[0]?.contact_id;
                    const contactName = item.contacts?.name ?? (item as any).action_item_contacts?.[0]?.contacts?.name;
                    const href = contactId ? `/contacts/${contactId}` : "/action-items";
                    return (
                      <Link key={item.id} href={href}>
                        <Card
                          variant="outlined"
                          className={`state-layer ${overdue ? "border-destructive/40" : ""}`}
                        >
                          <CardContent className="p-4 flex items-start gap-3">
                            <div
                              className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
                                overdue ? "bg-error-container" : "bg-primary-container"
                              }`}
                            >
                              {overdue ? (
                                <AlertTriangle className="h-4 w-4 text-on-error-container" />
                              ) : (
                                <CheckSquare className="h-4 w-4 text-on-primary-container" />
                              )}
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-foreground truncate">
                                {item.title}
                              </p>
                              <p className="text-xs text-muted-foreground truncate">
                                {contactName}
                                {item.due_at &&
                                  ` · ${overdue ? "Overdue" : "Due"}: ${new Date(
                                    item.due_at
                                  ).toLocaleDateString()}`}
                              </p>
                            </div>
                          </CardContent>
                        </Card>
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>

            {/* ── Reach Out Today ── */}
            {reachOutToday.length > 0 && (
              <div className="mb-10">
                <div className="flex items-center gap-2 mb-3">
                  <Send className="h-4 w-4 text-primary" />
                  <h2 className="text-sm font-medium text-foreground">Reach out today</h2>
                  <span className="text-xs text-muted-foreground ml-1">
                    {reachOutToday.length} {reachOutToday.length === 1 ? "contact" : "contacts"} need attention
                  </span>
                </div>
                <div className="space-y-1.5">
                  {reachOutToday.map((item) => (
                    <Link key={item.id} href={`/contacts/${item.id}`}>
                      <Card
                        variant="outlined"
                        className={`state-layer ${item.urgency >= 100 ? "border-destructive/40" : ""}`}
                      >
                        <CardContent className="p-4 flex items-center gap-3">
                          <div
                            className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-xs font-medium ${
                              item.urgency >= 100
                                ? "bg-error-container text-on-error-container"
                                : item.urgency >= 50
                                ? "bg-[#ffe0b2] text-[#e65100]"
                                : "bg-secondary-container text-on-secondary-container"
                            }`}
                          >
                            {item.name.charAt(0).toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-foreground truncate">{item.name}</p>
                            <p className="text-xs text-muted-foreground truncate">{item.reason}</p>
                          </div>
                          {item.urgency >= 100 && (
                            <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
                          )}
                        </CardContent>
                      </Card>
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {/* ── Relationship Health ── */}
            {contactHealth.length > 0 && (
              <div className="mb-10">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Users className="h-4 w-4 text-primary" />
                    <h2 className="text-sm font-medium text-foreground">Network health</h2>
                  </div>
                  <Link
                    href="/contacts"
                    className="text-xs font-medium text-primary flex items-center gap-0.5 hover:underline"
                  >
                    View all <ArrowRight className="h-3 w-3" />
                  </Link>
                </div>

                {/* Health summary bar */}
                <div className="flex gap-3 mb-4">
                  {(["green", "yellow", "orange", "red"] as const).map((color) => (
                    <div key={color} className="flex items-center gap-1.5">
                      <div className={`w-3 h-3 rounded-full ${healthStyles[color].split(" ")[0]}`} />
                      <span className="text-xs text-muted-foreground">
                        {healthStats[color]}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Contact grid */}
                <div className="flex flex-wrap gap-2">
                  {sortedHealthGrid.map((c) => {
                      const color = getHealthColor(c.days_since_touch);
                      return (
                        <Link key={c.id} href={`/contacts/${c.id}`} title={`${c.name} — ${
                          c.days_since_touch === null
                            ? "Never contacted"
                            : c.days_since_touch === 0
                            ? "Contacted today"
                            : `${c.days_since_touch}d since last contact`
                        }`}>
                          <div
                            className={`w-10 h-10 rounded-full flex items-center justify-center text-xs font-medium transition-all hover:ring-2 hover:scale-110 cursor-pointer ${healthStyles[color]}`}
                          >
                            {c.name.charAt(0).toUpperCase()}
                          </div>
                        </Link>
                      );
                    })}
                </div>

                {/* Legend */}
                <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3">
                  {(["green", "yellow", "orange", "red"] as const).map((color) => (
                    <span key={color} className="text-[10px] text-muted-foreground flex items-center gap-1">
                      <span className={`inline-block w-2 h-2 rounded-full ${healthStyles[color].split(" ")[0]}`} />
                      {healthLabels[color]}
                    </span>
                  ))}
                </div>
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

          </>
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
