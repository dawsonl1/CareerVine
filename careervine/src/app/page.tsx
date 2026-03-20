/**
 * Dashboard page (route: /) — CareerVine hub
 *
 * The landing page after login. Sections:
 *   1. Quick-add contact form (inline, not modal)
 *   2. Follow-up reminders — contacts overdue based on follow_up_frequency_days
 *   3. Recent contacts — last 6 contacts sorted by name
 *   4. Upcoming action items — next 6 pending items sorted by due date
 *
 * Data flow:
 *   loadData() → getContacts + getActionItems + getContactsDueForFollowUp
 */

"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useAuth } from "@/components/auth-provider";
import AuthForm from "@/components/auth-form";
import Navigation from "@/components/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { createContact, getContacts, getActionItems, getContactsDueForFollowUp } from "@/lib/queries";
import type { Database } from "@/lib/database.types";
import {
  UserPlus,
  ArrowRight,
  CheckSquare,
  AlertTriangle,
  Sprout,
  Clock,
} from "lucide-react";

type Contact = Database["public"]["Tables"]["contacts"]["Row"];
type ActionItem = Database["public"]["Tables"]["follow_up_action_items"]["Row"] & {
  contacts: Database["public"]["Tables"]["contacts"]["Row"];
};

const inputClasses =
  "w-full h-14 px-4 bg-surface-container-low text-foreground rounded-[4px] border border-outline placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:border-2 transition-colors text-sm";

export default function Home() {
  const { user, loading } = useAuth();

  // Quick-add contact form
  const [name, setName] = useState("");
  const [industry, setIndustry] = useState("");
  const [metThrough, setMetThrough] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [quickAddError, setQuickAddError] = useState<string | null>(null);

  // Recent contacts
  const [recentContacts, setRecentContacts] = useState<Contact[]>([]);

  // Upcoming action items
  const [actionItems, setActionItems] = useState<ActionItem[]>([]);

  // Follow-up reminders
  type FollowUpContact = { id: number; name: string; industry: string | null; follow_up_frequency_days: number; last_touch: string | null; days_overdue: number };
  const [followUps, setFollowUps] = useState<FollowUpContact[]>([]);

  useEffect(() => {
    if (user) {
      loadData();
    }
  }, [user, loadData]);

  const loadData = useCallback(async () => {
    if (!user) return;
    try {
      const [contacts, items, dueContacts] = await Promise.all([
        getContacts(user.id),
        getActionItems(user.id),
        getContactsDueForFollowUp(user.id),
      ]);
      // Show the 5 most recently created contacts (highest id = newest)
      setRecentContacts(
        [...(contacts as Contact[])].sort((a, b) => b.id - a.id).slice(0, 5)
      );
      setActionItems((items as ActionItem[]).slice(0, 4));
      setFollowUps(dueContacts);
    } catch (e) {
      console.error("Error loading home data:", e);
    }
  }, [user]);

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

  if (!user) {
    return <AuthForm />;
  }

  return (
    <div className="min-h-screen bg-background">
      <Navigation />

      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        {/* Greeting */}
        <div className="mb-10">
          <h1 className="text-[28px] leading-9 font-normal text-foreground">
            Hey, {user?.user_metadata?.first_name || "there"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Who did you meet today?
          </p>
        </div>

        {/* ── Quick-add contact ── */}
        <Card variant="outlined" className="mb-10">
          <CardContent className="p-6">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 rounded-full bg-primary-container flex items-center justify-center">
                <UserPlus className="h-5 w-5 text-on-primary-container" />
              </div>
              <div>
                <h2 className="text-base font-medium text-foreground">Add a contact</h2>
                <p className="text-xs text-muted-foreground">Save someone you just met — you can fill in more details later.</p>
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

        {/* ── Follow-up reminders ── */}
        {followUps.length > 0 && (
          <div className="mb-10">
            <div className="flex items-center gap-2 mb-3">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-medium text-muted-foreground">Due for follow-up</h2>
            </div>
            <div className="space-y-2">
              {followUps.slice(0, 5).map((c) => (
                <Link key={c.id} href={`/contacts/${c.id}`}>
                  <Card variant="outlined" className={`state-layer ${c.days_overdue > c.follow_up_frequency_days ? "border-destructive/40" : ""}`}>
                    <CardContent className="p-4 flex items-center gap-3">
                      <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
                        c.days_overdue > c.follow_up_frequency_days ? "bg-error-container" : "bg-secondary-container"
                      }`}>
                        {c.days_overdue > c.follow_up_frequency_days
                          ? <AlertTriangle className="h-4 w-4 text-on-error-container" />
                          : <Clock className="h-4 w-4 text-on-secondary-container" />
                        }
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{c.name}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {c.days_overdue === 0
                            ? "Due today"
                            : `${c.days_overdue} day${c.days_overdue !== 1 ? "s" : ""} overdue`
                          }
                          {c.last_touch
                            ? ` · Last contact: ${new Date(c.last_touch).toLocaleDateString()}`
                            : " · Never contacted"
                          }
                        </p>
                      </div>
                      <span className="text-xs text-muted-foreground shrink-0">Every {c.follow_up_frequency_days}d</span>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* ── Two-column: Recent contacts + Action items ── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Recent contacts */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-medium text-muted-foreground">Recent contacts</h2>
              <Link href="/contacts" className="text-xs font-medium text-primary flex items-center gap-0.5 hover:underline">
                View all <ArrowRight className="h-3 w-3" />
              </Link>
            </div>

            {recentContacts.length === 0 ? (
              <Card variant="filled" className="text-center py-10">
                <CardContent>
                  <Sprout className="mx-auto h-8 w-8 text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">
                    No contacts yet — add your first one above.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-2">
                {recentContacts.map((contact) => (
                  <Link key={contact.id} href={`/contacts/${contact.id}`}>
                    <Card variant="outlined" className="state-layer">
                      <CardContent className="p-4 flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-primary-container flex items-center justify-center shrink-0 text-on-primary-container text-xs font-medium">
                          {contact.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">{contact.name}</p>
                          <p className="text-xs text-muted-foreground truncate">
                            {[contact.industry, contact.met_through].filter(Boolean).join(" · ") || "No details yet"}
                          </p>
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* Upcoming action items */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-medium text-muted-foreground">Action items</h2>
              <Link href="/action-items" className="text-xs font-medium text-primary flex items-center gap-0.5 hover:underline">
                View all <ArrowRight className="h-3 w-3" />
              </Link>
            </div>

            {actionItems.length === 0 ? (
              <Card variant="filled" className="text-center py-10">
                <CardContent>
                  <CheckSquare className="mx-auto h-8 w-8 text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">
                    No pending action items.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-2">
                {actionItems.map((item) => {
                  const overdue = item.due_at && new Date(item.due_at) < new Date();
                  return (
                    <Link key={item.id} href="/action-items">
                      <Card variant="outlined" className={`state-layer ${overdue ? "border-destructive/40" : ""}`}>
                        <CardContent className="p-4 flex items-start gap-3">
                          <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${overdue ? "bg-error-container" : "bg-primary-container"}`}>
                            {overdue
                              ? <AlertTriangle className="h-4 w-4 text-on-error-container" />
                              : <CheckSquare className="h-4 w-4 text-on-primary-container" />
                            }
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-foreground truncate">{item.title}</p>
                            <p className="text-xs text-muted-foreground truncate">
                              {item.contacts.name}
                              {item.due_at && ` · ${overdue ? "Overdue" : "Due"}: ${new Date(item.due_at).toLocaleDateString()}`}
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
        </div>
      </main>
    </div>
  );
}
