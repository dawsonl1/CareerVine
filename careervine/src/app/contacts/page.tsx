"use client";

import { useState, useEffect, useMemo, useRef, useCallback, useDeferredValue } from "react";
import { useClickOutside } from "@/hooks/use-click-outside";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import { useToast } from "@/components/ui/toast";
import Navigation from "@/components/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  getContactsStreamed, createContact, findOrCreateSchool, addSchoolToContact,
  findOrCreateCompany, addCompanyToContact,
  addEmailToContact, addPhoneToContact,
  getTags, createTag, addTagToContact, findOrCreateLocation,
  activateContact, getNetworkTierCounts,
} from "@/lib/queries";
import { promoteContactToProspect, demoteContactToBench } from "@/lib/company-queries";
import { track } from "@/lib/analytics/client";
import type { ContactListItem, TagRow } from "@/lib/types";
import {
  Plus, Users, Search, ChevronDown, Mail, Phone,
  Tag, ExternalLink, Briefcase, GraduationCap, Check, Trash2, X, UserPlus,
  Archive, ArchiveRestore,
} from "lucide-react";
import { SchoolAutocomplete } from "@/components/ui/school-autocomplete";
import { MonthYearPicker } from "@/components/ui/month-year-picker";
import { DegreeAutocomplete } from "@/components/ui/degree-autocomplete";
import { Select } from "@/components/ui/select";
import { StateSelect } from "@/components/ui/state-select";
import { Checkbox } from "@/components/ui/checkbox";
import { inputClasses, labelClasses, FOLLOW_UP_OPTIONS } from "@/lib/form-styles";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { Tooltip } from "@/components/ui/tooltip";

type CompanyEntry = { company_name: string; title: string; location?: string; is_current: boolean; start_month: string; end_month: string };

const emptyForm = {
  name: "", industry: "", linkedin_url: "", notes: "", met_through: "",
  follow_up_frequency_days: "", contact_status: "", expected_graduation: "",
  school_name: "", degree: "", field_of_study: "",
  location_city: "", location_state: "", location_country: "United States",
};

export default function ContactsPage() {
  const { user } = useAuth();
  const router = useRouter();
  const { success: toastSuccess, error: toastError } = useToast();
  const [contacts, setContacts] = useState<ContactListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTagFilter, setSelectedTagFilter] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [showSearchSuggestions, setShowSearchSuggestions] = useState(true);
  const searchRef = useRef<HTMLDivElement>(null);
  useClickOutside(searchRef, useCallback(() => setShowSearchSuggestions(false), []), showSearchSuggestions);

  // Create contact form state
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState(emptyForm);
  const [companies, setCompanies] = useState<CompanyEntry[]>([]);
  type EmailEntry = { email: string; is_primary: boolean };
  type PhoneEntry = { phone: string; type: string; is_primary: boolean };
  const [emails, setEmails] = useState<EmailEntry[]>([]);
  const [phones, setPhones] = useState<PhoneEntry[]>([]);
  const [preferredContactKey, setPreferredContactKey] = useState("");
  const [showEducation, setShowEducation] = useState(false);
  const [showCustomFrequency, setShowCustomFrequency] = useState(false);
  const [allTags, setAllTags] = useState<TagRow[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>([]);
  const [tagSearch, setTagSearch] = useState("");
  const [showTagDropdown, setShowTagDropdown] = useState(false);

  // Network tiers as independent toggles — the list shows the union of
  // whichever tiers are switched on. Default is the hand-curated network
  // only; imported prospects and the archive stay out of the way until
  // toggled in (plan 24 containment).
  const [enabledTiers, setEnabledTiers] = useState<Set<"active" | "prospect" | "bench">>(
    () => new Set(["active"])
  );
  // True once every tier is in memory — toggle flips are then instant
  const [allTiersLoaded, setAllTiersLoaded] = useState(false);
  // Lightweight head-count results shown on the chips until the full
  // contact payload lands
  const [serverTierCounts, setServerTierCounts] = useState<{ active: number; prospect: number; bench: number } | null>(null);

  const toggleTier = (tier: "active" | "prospect" | "bench") => {
    setEnabledTiers((prev) => {
      const next = new Set(prev);
      if (next.has(tier)) next.delete(tier);
      else next.add(tier);
      return next;
    });
  };

  const loadContacts = useCallback(async () => {
    if (!user) return;
    try {
      // Stream every tier in parallel. getContactsStreamed pulls a small first
      // page (50) then large pages, in name order, so each tier paints its
      // first ~50 rows fast and backfills the rest in the background. Running
      // the tiers as independent streams (rather than one all-tiers superset)
      // means: the active network — the default view — paints from its own
      // first page without waiting on the prospect/bench archive, no tier
      // blocks another, and active is never fetched twice. Prospect/bench still
      // load fully so their toggles stay in-memory once switched on.
      const byId = new Map<number, ContactListItem>();
      const flush = () =>
        setContacts(Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name)));

      const TIERS = ["active", "prospect", "bench"] as const;
      await Promise.all(
        TIERS.map(async (tier) => {
          await getContactsStreamed(user.id, [tier], (rows) => {
            for (const r of rows as ContactListItem[]) byId.set(r.id, r);
            flush();
            // First paint on the active tier's first page (the default view).
            if (tier === "active") setLoading(false);
          });
          // Active tier settled — clear the spinner even if it had zero rows
          // (a bundle account starts with 0 active, so the onPage above never
          // fires and can't unblock the list). CAR-96.
          if (tier === "active") setLoading(false);
        }),
      );
      setLoading(false);
      setAllTiersLoaded(true);
    } catch (error) {
      // Postgrest errors are plain objects that log as "{}" — pull the fields out
      const e = error as { message?: string; code?: string; details?: string; hint?: string };
      console.error(
        `Error loading contacts: ${e?.message || String(error)}`,
        JSON.stringify({ code: e?.code, details: e?.details, hint: e?.hint })
      );
    } finally {
      setLoading(false);
    }
  }, [user]);

  // The chips repaint instantly on click; the expensive list re-render
  // (hundreds of rows) follows behind via the deferred value so the
  // toggle animation isn't blocked waiting for it.
  const deferredTiers = useDeferredValue(enabledTiers);

  // Per-tier counts for the toggle chips: derived from the loaded
  // superset once it's in memory (stays live as contacts are promoted),
  // otherwise the fast head-count results; null until either arrives
  const tierCounts = useMemo(() => {
    if (!allTiersLoaded) return serverTierCounts;
    const counts = { active: 0, prospect: 0, bench: 0 };
    for (const c of contacts) {
      if (c.network_status in counts) counts[c.network_status as keyof typeof counts]++;
    }
    return counts;
  }, [contacts, allTiersLoaded, serverTierCounts]);

  // Hide the tier toggles entirely for accounts with no prospects or
  // archived contacts — new users just see their network, no set math
  const tiersExist = ((tierCounts?.prospect ?? 0) + (tierCounts?.bench ?? 0)) > 0;

  // The view is a pure client-side filter over the loaded superset.
  // With no toggles on screen, the view is always the active network.
  const visibleContacts = useMemo(() => {
    if (!tiersExist) return contacts.filter((c) => c.network_status === "active");
    return contacts.filter((c) => deferredTiers.has(c.network_status as "active" | "prospect" | "bench"));
  }, [contacts, deferredTiers, tiersExist]);

  // Blocking spinner for a prospect/bench view only while it has NOTHING to
  // show yet. Once the first page of the enabled tier is in memory, render those
  // cards and let the rest stream in behind — never hide loaded rows behind a
  // spinner waiting for the full backfill (CAR-96).
  const viewLoading =
    tiersExist &&
    !allTiersLoaded &&
    visibleContacts.length === 0 &&
    (enabledTiers.has("prospect") || enabledTiers.has("bench"));

  useEffect(() => {
    if (user) {
      loadContacts();
      // Chip counts arrive in milliseconds, well before the full payload
      getNetworkTierCounts().then(setServerTierCounts).catch(() => {});
      getTags(user.id).then(setAllTags).catch(() => {});
    }
  }, [user, loadContacts]);

  const uniqueTags = useMemo(() => {
    const tagMap = new Map<number, string>();
    for (const c of contacts) {
      for (const ct of c.contact_tags) {
        tagMap.set(ct.tag_id, ct.tags.name);
      }
    }
    return Array.from(tagMap, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [contacts]);

  // Search suggestions: people matching by name, email, company, job
  // title, school, or industry — then tag-only matches
  const { nameSuggestions, tagSuggestions } = useMemo(() => {
    if (!searchQuery.trim()) return { nameSuggestions: [], tagSuggestions: [] };
    const q = searchQuery.toLowerCase();
    const nameHit = (c: ContactListItem) =>
      c.name.toLowerCase().includes(q) ||
      c.contact_emails.some((e) => e.email?.toLowerCase().includes(q)) ||
      c.contact_companies.some((cc) => cc.companies.name.toLowerCase().includes(q) || cc.title?.toLowerCase().includes(q)) ||
      c.contact_schools.some((cs) => cs.schools.name.toLowerCase().includes(q)) ||
      c.industry?.toLowerCase().includes(q);
    const tagHit = (c: ContactListItem) => c.contact_tags.some((ct) => ct.tags.name.toLowerCase().includes(q));
    const nameSuggestions = visibleContacts.filter(nameHit).slice(0, 5);
    const nameIds = new Set(nameSuggestions.map(c => c.id));
    const tagSuggestions = visibleContacts.filter(c => !nameIds.has(c.id) && tagHit(c)).slice(0, 5);
    return { nameSuggestions, tagSuggestions };
  }, [visibleContacts, searchQuery]);

  const filteredContacts = useMemo(() => {
    let result = visibleContacts;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((c) =>
        c.name.toLowerCase().includes(q) ||
        c.industry?.toLowerCase().includes(q) ||
        c.contact_emails.some((e) => e.email?.toLowerCase().includes(q)) ||
        c.contact_companies.some((cc) => cc.companies.name.toLowerCase().includes(q) || cc.title?.toLowerCase().includes(q)) ||
        c.contact_schools.some((cs) => cs.schools.name.toLowerCase().includes(q)) ||
        c.contact_tags.some((ct) => ct.tags.name.toLowerCase().includes(q))
      );
    }
    if (selectedTagFilter !== null) {
      result = result.filter((c) => c.contact_tags.some((ct) => ct.tag_id === selectedTagFilter));
    }
    return result;
  }, [visibleContacts, searchQuery, selectedTagFilter]);

  const handleActivate = async (contact: ContactListItem) => {
    try {
      await activateContact(contact.id);
      setContacts((prev) =>
        prev.map((c) => (c.id === contact.id ? { ...c, network_status: "active" } : c))
      );
      toastSuccess(`${contact.name} added to your network`);
    } catch {
      toastError("Failed to add to network");
    }
  };

  const handleSetTier = async (contact: ContactListItem, tier: "prospect" | "bench") => {
    try {
      if (tier === "prospect") await promoteContactToProspect(contact.id);
      else await demoteContactToBench(contact.id);
      setContacts((prev) =>
        prev.map((c) => (c.id === contact.id ? { ...c, network_status: tier } : c))
      );
      toastSuccess(tier === "prospect" ? `${contact.name} moved to prospects` : `${contact.name} archived`);
    } catch {
      toastError("Failed to move contact");
    }
  };

  const closeForm = () => {
    setShowForm(false);
    setFormData(emptyForm);
    setCompanies([]);
    setEmails([]);
    setPhones([]);
    setSelectedTagIds([]);
    setTagSearch("");
    setPreferredContactKey("");
    setShowEducation(false);
    setShowCustomFrequency(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    try {
      const contactData = {
        user_id: user.id,
        name: formData.name,
        industry: formData.industry || null,
        linkedin_url: formData.linkedin_url || null,
        notes: formData.notes || null,
        met_through: formData.met_through || null,
        follow_up_frequency_days: formData.follow_up_frequency_days ? parseInt(formData.follow_up_frequency_days) : null,
        preferred_contact_method: (() => {
          if (!preferredContactKey) return null;
          const [type, idxStr] = preferredContactKey.split("-");
          const idx = parseInt(idxStr);
          if (type === "email" && emails[idx]?.email) return "email";
          if (type === "phone" && phones[idx]?.phone) return "phone";
          return null;
        })(),
        preferred_contact_value: (() => {
          if (!preferredContactKey) return null;
          const [type, idxStr] = preferredContactKey.split("-");
          const idx = parseInt(idxStr);
          if (type === "email") return emails[idx]?.email || null;
          if (type === "phone") return phones[idx]?.phone || null;
          return null;
        })(),
        contact_status: formData.contact_status || null,
        expected_graduation: formData.contact_status === "student" ? (formData.expected_graduation || null) : null,
        location_id: null as number | null,
      };

      if (formData.location_city || formData.location_state) {
        const location = await findOrCreateLocation({
          city: formData.location_city || null,
          state: formData.location_state || null,
          country: formData.location_country || "United States",
        });
        contactData.location_id = location.id;
      }

      const created = await createContact(contactData);
      const contactId = created.id;

      for (const entry of companies) {
        if (entry.company_name.trim()) {
          const company = await findOrCreateCompany(entry.company_name.trim());
          await addCompanyToContact({
            contact_id: contactId,
            company_id: company.id,
            title: entry.title || null,
            location: entry.location || null,
            is_current: entry.is_current,
            start_date: null,
            end_date: null,
            start_month: entry.start_month || null,
            end_month: entry.is_current ? "Present" : (entry.end_month || null),
          });
        }
      }

      if (formData.school_name.trim()) {
        const school = await findOrCreateSchool(formData.school_name.trim());
        await addSchoolToContact({
          contact_id: contactId,
          school_id: school.id,
          degree: formData.degree || null,
          field_of_study: formData.field_of_study || null,
          start_year: null,
          end_year: null,
        });
      }

      for (const entry of emails) {
        if (entry.email.trim()) {
          await addEmailToContact(contactId, entry.email.trim(), entry.is_primary);
        }
      }
      for (const entry of phones) {
        if (entry.phone.trim()) {
          await addPhoneToContact(contactId, entry.phone.trim(), entry.type || "mobile", entry.is_primary);
        }
      }

      for (const tagId of selectedTagIds) await addTagToContact(contactId, tagId);

      track("contact_imported", { source: "manual" });
      // Manual adds happen via the browser Supabase client, so the server
      // never sees them — ask it to re-check the contacts_5 milestone.
      void fetch("/api/analytics/milestones", { method: "POST" }).catch(() => {});

      closeForm();
      await loadContacts();
      toastSuccess("Contact created");
    } catch (error) {
      toastError("Failed to create contact");
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <div className="flex items-center gap-3 text-muted-foreground">
            <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
            <span className="text-base">Loading contacts…</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        {/* Header */}
        <div className="flex justify-between items-center mb-10">
          <div>
            <h1 className="text-[28px] leading-9 font-normal text-foreground">Contacts</h1>
            <p className="text-base text-muted-foreground mt-1">
              {visibleContacts.length} {visibleContacts.length === 1 ? "person" : "people"} in your network
            </p>
          </div>
          <Button onClick={() => setShowForm(true)}>
            <Plus className="h-[18px] w-[18px]" /> Add contact
          </Button>
        </div>

        {/* Search bar + suggestions */}
        <div className="relative mb-4" ref={searchRef}>
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setShowSearchSuggestions(true); }}
            onFocus={() => setShowSearchSuggestions(true)}
            className="w-full h-12 pl-11 pr-4 bg-surface-container-low text-foreground rounded-full border border-outline-variant placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:border-2 transition-colors text-base"
            placeholder="Search contacts…"
          />
          {showSearchSuggestions && searchQuery.trim() && (nameSuggestions.length > 0 || tagSuggestions.length > 0) && (
            <div className="absolute left-0 top-full mt-1.5 w-full z-50 bg-surface-container-high rounded-2xl shadow-lg border border-outline-variant overflow-hidden">
              {nameSuggestions.map((c) => {
                const currentCompany = c.contact_companies.find((cc) => cc.is_current);
                return (
                  <button key={c.id} type="button" onClick={() => { router.push(`/contacts/${c.id}`); setSearchQuery(""); }}
                    className="w-full flex items-center gap-4 px-5 py-3 hover:bg-surface-container cursor-pointer transition-colors text-left">
                    <ContactAvatar name={c.name} photoUrl={c.photo_url} className="w-10 h-10 text-sm" />
                    <div className="min-w-0 flex-1">
                      <p className="text-base text-foreground truncate">{c.name}</p>
                      {currentCompany && <p className="text-sm text-muted-foreground truncate">{currentCompany.title}{currentCompany.title && currentCompany.companies.name ? " at " : ""}{currentCompany.companies.name}</p>}
                    </div>
                  </button>
                );
              })}
              {tagSuggestions.length > 0 && (
                <>
                  <p className="px-5 pt-2.5 pb-1 text-[11px] font-medium text-muted-foreground uppercase tracking-wide border-t border-outline-variant/50">By tag</p>
                  {tagSuggestions.map((c) => {
                    const matchedTag = c.contact_tags.find(ct => ct.tags.name.toLowerCase().includes(searchQuery.toLowerCase()));
                    const currentCompany = c.contact_companies.find((cc) => cc.is_current);
                    return (
                      <button key={c.id} type="button" onClick={() => { router.push(`/contacts/${c.id}`); setSearchQuery(""); }}
                        className="w-full flex items-center gap-4 px-5 py-3 hover:bg-surface-container cursor-pointer transition-colors text-left">
                        <ContactAvatar name={c.name} photoUrl={c.photo_url} className="w-10 h-10 text-sm" />
                        <div className="min-w-0 flex-1">
                          <p className="text-base text-foreground truncate">{c.name}</p>
                          {currentCompany && <p className="text-sm text-muted-foreground truncate">{currentCompany.title}{currentCompany.title && currentCompany.companies.name ? " at " : ""}{currentCompany.companies.name}</p>}
                        </div>
                        {matchedTag && (
                          <span className="text-[11px] px-2.5 py-0.5 rounded-full bg-surface-container text-muted-foreground shrink-0">{matchedTag.tags.name}</span>
                        )}
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          )}
        </div>

        {/* Network tier toggles — each chip flips a tier in or out of view.
            Hidden entirely when there's nothing beyond the active network. */}
        {tiersExist && (
        <div className="flex items-center gap-2 mb-4">
          {([
            // onClasses mirror the avatar-halo colors: green = network,
            // teal = prospects, gray = archive
            { key: "active", label: "My network", onClasses: "bg-secondary-container text-on-secondary-container" },
            { key: "prospect", label: "Prospects", onClasses: "bg-teal-100 text-teal-900" },
            { key: "bench", label: "Archive", onClasses: "bg-surface-container-highest text-foreground" },
          ] as const).map((v) => {
            const on = enabledTiers.has(v.key);
            return (
              <button
                key={v.key}
                onClick={() => toggleTier(v.key)}
                aria-pressed={on}
                className={`inline-flex items-center h-9 px-3.5 rounded-full text-sm font-medium cursor-pointer border transition-colors duration-200 ${
                  on
                    ? `${v.onClasses} border-transparent`
                    : "bg-transparent text-foreground border-outline hover:bg-surface-container"
                }`}
              >
                {/* Check slides open/closed so the label doesn't jump */}
                <span
                  aria-hidden
                  className={`overflow-hidden transition-all duration-200 ease-out ${
                    on ? "w-4 mr-1.5 opacity-100" : "w-0 mr-0 opacity-0"
                  }`}
                >
                  <Check className="h-4 w-4" />
                </span>
                {v.label}
                {tierCounts && (
                  <span className="ml-1.5 text-muted-foreground">{tierCounts[v.key]}</span>
                )}
              </button>
            );
          })}
        </div>
        )}

        {/* Prefetch still in flight for non-active tiers */}
        {viewLoading && (
          <div className="flex items-center gap-3 text-muted-foreground py-8 justify-center">
            <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
            <span className="text-base">Loading contacts…</span>
          </div>
        )}

        {/* Nothing toggled on */}
        {!viewLoading && tiersExist && enabledTiers.size === 0 && (
          <p className="text-base text-muted-foreground py-8 text-center">
            No groups selected. Toggle a group above to see people.
          </p>
        )}

        {/* Empty state — the network itself is empty and only it is selected.
            Stays up even when prospects/archive exist in other tiers. */}
        {!viewLoading && visibleContacts.length === 0 && enabledTiers.size === 1 && enabledTiers.has("active") && (
          <Card variant="outlined" className="text-center py-16">
            <CardContent>
              <Users className="mx-auto h-14 w-14 text-muted-foreground/40 mb-5" />
              <p className="text-lg text-foreground mb-1">Your network starts here</p>
              <p className="text-base text-muted-foreground mb-2.5">
                Add people you meet: colleagues, mentors, classmates, or anyone worth staying in touch with.
              </p>
              <p className="text-sm text-muted-foreground mb-6">
                You can also import contacts from LinkedIn using the Chrome extension.
              </p>
              <Button onClick={() => setShowForm(true)}>
                <Plus className="h-[18px] w-[18px]" /> Add your first contact
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Selected groups are empty — only when a non-default selection is active */}
        {!viewLoading && visibleContacts.length === 0 && enabledTiers.size > 0 && !(enabledTiers.size === 1 && enabledTiers.has("active")) && (
          <p className="text-base text-muted-foreground py-8 text-center">
            No contacts in the selected groups.
          </p>
        )}

        {/* No search results */}
        {!viewLoading && visibleContacts.length > 0 && filteredContacts.length === 0 && (
          <p className="text-base text-muted-foreground py-8 text-center">No contacts match your search.</p>
        )}

        {/* Contact list */}
        <div className="space-y-2">
          {filteredContacts.map((contact) => {
            const isExpanded = expandedId === contact.id;
            const currentCompany = contact.contact_companies.find((cc) => cc.is_current);
            const school = contact.contact_schools[0]?.schools;
            const primaryEmail = contact.contact_emails.find((e) => e.is_primary) || contact.contact_emails[0];

            return (
              <div key={contact.id} className="rounded-[12px] border border-outline-variant/60 bg-white hover:border-outline-variant hover:shadow-sm transition-all">
                <div
                  className="flex items-center gap-5 p-5 cursor-pointer"
                  onClick={() => router.push(`/contacts/${contact.id}`)}
                >
                  {/* Avatar — tier signal: vivid teal halo = prospect,
                      grayscale photo + gray halo = archived, clean = network */}
                  <ContactAvatar
                    name={contact.name}
                    photoUrl={contact.photo_url}
                    className={`w-14 h-14 text-base ${contact.network_status === "bench" ? "grayscale opacity-75" : ""}`}
                    ringClassName={
                      contact.network_status === "prospect"
                        ? "ring-teal-500 ring-offset-2"
                        : contact.network_status === "bench"
                          ? "ring-outline ring-offset-2"
                          : ""
                    }
                  />

                  {/* Name + job title */}
                  <div className="flex-1 min-w-0">
                    <h3 className="text-lg font-medium text-foreground truncate">{contact.name}</h3>
                    <p className="text-base text-muted-foreground truncate">
                      {currentCompany?.title || contact.industry || "No details"}
                    </p>
                  </div>

                  {/* Email + school + current company — appears from md and
                      grows fluidly with the viewport (truncating with … when
                      tight) up to 240px. Width is viewport-driven, so the
                      column stays vertically aligned across cards. */}
                  <div className="hidden md:flex flex-col gap-0.5 w-[clamp(140px,18vw,240px)] shrink-0">
                    {primaryEmail && (
                      <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground min-w-0">
                        <Mail className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{primaryEmail.email}</span>
                      </span>
                    )}
                    {school && (
                      <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground min-w-0">
                        <GraduationCap className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{school.name}</span>
                      </span>
                    )}
                    {currentCompany && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); router.push(`/companies/${currentCompany.companies.id}`); }}
                        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary hover:underline min-w-0 cursor-pointer text-left"
                        title={`View ${currentCompany.companies.name}`}
                      >
                        <Briefcase className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{currentCompany.companies.name}</span>
                      </button>
                    )}
                  </div>

                  {/* Tier moves — add to network on top, prospect⇄archive below */}
                  {contact.network_status !== "active" && (
                    <div className="flex flex-col gap-0.5 shrink-0">
                      <Tooltip label="Add to network">
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handleActivate(contact); }}
                          className="p-1.5 rounded-[10px] text-muted-foreground hover:text-primary hover:bg-secondary/60 cursor-pointer transition-colors"
                        >
                          <UserPlus className="h-5 w-5" />
                        </button>
                      </Tooltip>
                      {contact.network_status === "prospect" ? (
                        <Tooltip label="Move to archive">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); handleSetTier(contact, "bench"); }}
                            className="p-1.5 rounded-[10px] text-muted-foreground hover:text-primary hover:bg-secondary/60 cursor-pointer transition-colors"
                          >
                            <Archive className="h-5 w-5" />
                          </button>
                        </Tooltip>
                      ) : (
                        <Tooltip label="Move to prospects">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); handleSetTier(contact, "prospect"); }}
                            className="p-1.5 rounded-[10px] text-muted-foreground hover:text-primary hover:bg-secondary/60 cursor-pointer transition-colors"
                          >
                            <ArchiveRestore className="h-5 w-5" />
                          </button>
                        </Tooltip>
                      )}
                    </div>
                  )}

                  {/* Expand chevron — stops propagation so bar click doesn't navigate */}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setExpandedId(isExpanded ? null : contact.id); }}
                    className="group p-1.5 rounded-full text-muted-foreground hover:text-foreground cursor-pointer transition-colors shrink-0"
                    title="Quick preview"
                  >
                    <ChevronDown className={`h-5 w-5 transition-transform duration-200 ${isExpanded ? "rotate-0" : "-rotate-90 group-hover:rotate-0"}`} />
                  </button>
                </div>

                {/* Expanded preview */}
                {isExpanded && (
                  <div className="px-5 pb-5 pt-0 border-t border-outline-variant/30">
                    <div className="pt-3 space-y-2.5">
                      {/* Contact info chips */}
                      <div className="flex flex-wrap gap-2">
                        {contact.contact_emails.map((email) => (
                          <span key={email.id} className="inline-flex items-center gap-1.5 text-sm text-foreground bg-surface-container-low px-2.5 py-1 rounded-md">
                            <Mail className="h-3.5 w-3.5 text-muted-foreground" /> {email.email}
                            {email.is_primary && <span className="text-primary font-medium text-[11px]">·primary</span>}
                          </span>
                        ))}
                        {contact.contact_phones.map((phone) => (
                          <span key={phone.id} className="inline-flex items-center gap-1.5 text-sm text-foreground bg-surface-container-low px-2.5 py-1 rounded-md">
                            <Phone className="h-3.5 w-3.5 text-muted-foreground" /> {phone.phone}
                          </span>
                        ))}
                        {contact.linkedin_url && (
                          <a href={contact.linkedin_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-primary bg-surface-container-low px-2.5 py-1 rounded-md hover:underline">
                            <ExternalLink className="h-3.5 w-3.5" /> LinkedIn
                          </a>
                        )}
                      </div>

                      {/* Companies */}
                      {contact.contact_companies.length > 0 && (
                        <div className="space-y-0.5">
                          {contact.contact_companies.map((cc) => (
                            <p key={cc.id} className="text-sm text-muted-foreground">
                              <Briefcase className="h-3.5 w-3.5 inline mr-1" />
                              {cc.title}{cc.title && cc.companies.name ? " at " : ""}{cc.companies.name}
                              {cc.is_current && <span className="text-primary font-medium ml-1">· Current</span>}
                            </p>
                          ))}
                        </div>
                      )}

                      {/* School */}
                      {contact.contact_schools.length > 0 && (
                        <p className="text-sm text-muted-foreground">
                          <GraduationCap className="h-3.5 w-3.5 inline mr-1" />
                          {contact.contact_schools[0].degree}{contact.contact_schools[0].field_of_study ? ` in ${contact.contact_schools[0].field_of_study}` : ""} · {contact.contact_schools[0].schools.name}
                        </p>
                      )}

                      {contact.notes && (
                        <p className="text-sm text-muted-foreground line-clamp-2">{contact.notes}</p>
                      )}

                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="tonal"
                          size="sm"
                          onClick={() => router.push(`/contacts/${contact.id}`)}
                        >
                          View full profile
                        </Button>
                        {contact.network_status !== "active" && (
                          <Button
                            variant="tonal"
                            size="sm"
                            onClick={() => handleActivate(contact)}
                          >
                            <UserPlus className="h-4 w-4" /> Add to network
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Create contact modal */}
        {showForm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/32" onClick={closeForm} />
            <div className="relative w-full max-w-2xl bg-surface-container-high rounded-[28px] shadow-lg max-h-[90vh] overflow-y-auto">
              <div className="px-6 pt-6 pb-4">
                <h2 className="text-[22px] leading-7 font-normal text-foreground">New contact</h2>
              </div>
              <form onSubmit={handleSubmit} className="px-6 pb-6 space-y-4">
                {/* Basics */}
                <div>
                  <label className={labelClasses}>Name *</label>
                  <input type="text" required value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} className={inputClasses} placeholder="Full name" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelClasses}>Status</label>
                    <div className="inline-flex rounded-full border border-outline overflow-hidden">
                      {[{ value: "student", label: "Student" }, { value: "professional", label: "Professional" }].map((opt, idx) => (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => {
                            const newStatus = formData.contact_status === opt.value ? "" : opt.value;
                            setFormData({ ...formData, contact_status: newStatus });
                            if (opt.value === "student" && newStatus === "student") setShowEducation(true);
                            else if (newStatus !== "student") {
                              if (!formData.school_name.trim() && !formData.degree.trim() && !formData.field_of_study.trim()) setShowEducation(false);
                            }
                          }}
                          className={`flex-1 h-10 px-4 text-sm font-medium cursor-pointer transition-colors inline-flex items-center justify-center gap-1.5 ${idx > 0 ? "border-l border-outline" : ""} ${
                            formData.contact_status === opt.value
                              ? "bg-secondary-container text-on-secondary-container"
                              : "bg-transparent text-foreground hover:bg-surface-container"
                          }`}
                        >
                          {formData.contact_status === opt.value && <Check className="h-4 w-4" />}
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className={labelClasses}>Industry</label>
                    <input type="text" value={formData.industry} onChange={(e) => setFormData({ ...formData, industry: e.target.value })} className={inputClasses} placeholder="e.g. Technology" />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className={labelClasses}>City</label>
                    <input type="text" value={formData.location_city} onChange={(e) => setFormData({ ...formData, location_city: e.target.value })} className={inputClasses} placeholder="e.g. San Francisco" />
                  </div>
                  <div>
                    <label className={labelClasses}>State</label>
                    <StateSelect country={formData.location_country} value={formData.location_state} onChange={(val) => setFormData({ ...formData, location_state: val })} />
                  </div>
                  <div>
                    <label className={labelClasses}>Country</label>
                    <input type="text" value={formData.location_country} onChange={(e) => setFormData({ ...formData, location_country: e.target.value })} className={inputClasses} placeholder="e.g. United States" />
                  </div>
                </div>
                <div>
                  <label className={labelClasses}>Met at</label>
                  <input type="text" value={formData.met_through} onChange={(e) => setFormData({ ...formData, met_through: e.target.value })} className={inputClasses} placeholder="e.g. Conference, mutual friend" />
                </div>

                {/* Work */}
                <div className="pt-2 border-t border-outline-variant">
                  <label className={`${labelClasses} flex items-center gap-1.5 mb-3`}><Briefcase className="h-3.5 w-3.5" /> Work experience</label>
                  {companies.map((entry, i) => (
                    <div key={i} className="mb-3 p-3 rounded-[12px] bg-surface-container-low space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex gap-2">
                          {(["current", "past"] as const).map((type) => (
                            <button key={type} type="button" onClick={() => { const u = [...companies]; u[i] = { ...u[i], is_current: type === "current" }; setCompanies(u); }}
                              className={`h-8 px-3 rounded-full text-xs font-medium cursor-pointer transition-colors border ${(type === "current" ? entry.is_current : !entry.is_current) ? "bg-secondary-container text-on-secondary-container border-secondary-container" : "bg-transparent text-foreground border-outline-variant hover:bg-surface-container"}`}>
                              {type === "current" ? "Current" : "Past"}
                            </button>
                          ))}
                        </div>
                        <button type="button" onClick={() => setCompanies(companies.filter((_, j) => j !== i))} className="p-1 rounded-full text-muted-foreground hover:text-destructive cursor-pointer"><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <input type="text" value={entry.company_name} onChange={(e) => { const u = [...companies]; u[i] = { ...u[i], company_name: e.target.value }; setCompanies(u); }} className={`${inputClasses} !h-11`} placeholder="Company name" />
                        <input type="text" value={entry.title} onChange={(e) => { const u = [...companies]; u[i] = { ...u[i], title: e.target.value }; setCompanies(u); }} className={`${inputClasses} !h-11`} placeholder="Job title" />
                      </div>
                      <input type="text" value={entry.location} onChange={(e) => { const u = [...companies]; u[i] = { ...u[i], location: e.target.value }; setCompanies(u); }} className={`${inputClasses} !h-11`} placeholder="Location" />
                      <div className="grid grid-cols-2 gap-2">
                        <input type="text" value={entry.start_month} onChange={(e) => { const u = [...companies]; u[i] = { ...u[i], start_month: e.target.value }; setCompanies(u); }} className={`${inputClasses} !h-11`} placeholder="Start (e.g., Jan 2023)" />
                        {!entry.is_current ? (
                          <input type="text" value={entry.end_month} onChange={(e) => { const u = [...companies]; u[i] = { ...u[i], end_month: e.target.value }; setCompanies(u); }} className={`${inputClasses} !h-11`} placeholder="End (e.g., Dec 2024)" />
                        ) : (
                          <div className={`${inputClasses} !h-11 flex items-center text-muted-foreground`}>Present</div>
                        )}
                      </div>
                    </div>
                  ))}
                  <Button type="button" variant="tonal" size="sm" onClick={() => setCompanies([...companies, { company_name: "", title: "", location: "", is_current: true, start_month: "", end_month: "" }])}>
                    <Plus className="h-4 w-4" /> Add company
                  </Button>
                </div>

                {/* Education */}
                <div className="pt-2 border-t border-outline-variant">
                  {(showEducation || formData.contact_status === "student") ? (
                    <>
                      <label className={`${labelClasses} flex items-center gap-1.5 mb-3`}><GraduationCap className="h-3.5 w-3.5" /> Education</label>
                      <div className="space-y-3">
                        <div>
                          <label className={labelClasses}>School</label>
                          <SchoolAutocomplete value={formData.school_name} onChange={(val) => setFormData({ ...formData, school_name: val })} className={inputClasses} />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className={labelClasses}>Degree</label>
                            <DegreeAutocomplete value={formData.degree} onChange={(val) => setFormData({ ...formData, degree: val })} className={inputClasses} />
                          </div>
                          <div>
                            <label className={labelClasses}>Field of study</label>
                            <input type="text" value={formData.field_of_study} onChange={(e) => setFormData({ ...formData, field_of_study: e.target.value })} className={inputClasses} placeholder="e.g. Computer Science" />
                          </div>
                        </div>
                        {formData.contact_status === "student" && (
                          <div>
                            <label className={labelClasses}>Expected graduation</label>
                            <MonthYearPicker value={formData.expected_graduation} onChange={(val) => setFormData({ ...formData, expected_graduation: val })} placeholder="Select graduation month" />
                          </div>
                        )}
                      </div>
                    </>
                  ) : (
                    <Button type="button" variant="tonal" size="sm" onClick={() => setShowEducation(true)}>
                      <GraduationCap className="h-4 w-4" /> Add education
                    </Button>
                  )}
                </div>

                {/* Emails */}
                <div className="pt-2 border-t border-outline-variant">
                  <label className={`${labelClasses} flex items-center gap-1.5 mb-3`}><Mail className="h-3.5 w-3.5" /> Emails</label>
                  {emails.map((entry, i) => (
                    <div key={i} className="flex items-center gap-2 mb-2">
                      <input type="email" value={entry.email} onChange={(e) => { const u = [...emails]; u[i] = { ...u[i], email: e.target.value }; setEmails(u); }} className={`${inputClasses} !h-11 flex-1`} placeholder="email@example.com" />
                      <Checkbox checked={preferredContactKey === `email-${i}`} onChange={(checked) => setPreferredContactKey(checked ? `email-${i}` : "")} label="Preferred" />
                      <button type="button" onClick={() => {
                        if (preferredContactKey === `email-${i}`) setPreferredContactKey("");
                        else if (preferredContactKey.startsWith("email-")) { const oldIdx = parseInt(preferredContactKey.split("-")[1]); if (oldIdx > i) setPreferredContactKey(`email-${oldIdx - 1}`); }
                        setEmails(emails.filter((_, j) => j !== i));
                      }} className="p-1 rounded-full text-muted-foreground hover:text-destructive cursor-pointer shrink-0"><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>
                  ))}
                  <Button type="button" variant="tonal" size="sm" onClick={() => setEmails([...emails, { email: "", is_primary: emails.length === 0 }])}>
                    <Plus className="h-4 w-4" /> Add email
                  </Button>
                </div>

                {/* Phones */}
                <div className="pt-2 border-t border-outline-variant">
                  <label className={`${labelClasses} flex items-center gap-1.5 mb-3`}><Phone className="h-3.5 w-3.5" /> Phones</label>
                  {phones.map((entry, i) => (
                    <div key={i} className="flex items-center gap-2 mb-2">
                      <input type="tel" value={entry.phone} onChange={(e) => { const u = [...phones]; u[i] = { ...u[i], phone: e.target.value }; setPhones(u); }} className={`${inputClasses} !h-11 flex-1`} placeholder="555-123-4567" />
                      <div className="shrink-0 w-[100px]">
                        <Select value={entry.type} onChange={(val) => { const u = [...phones]; u[i] = { ...u[i], type: val }; setPhones(u); }} options={[{ value: "mobile", label: "Mobile" }, { value: "work", label: "Work" }, { value: "home", label: "Home" }]} />
                      </div>
                      <Checkbox checked={preferredContactKey === `phone-${i}`} onChange={(checked) => setPreferredContactKey(checked ? `phone-${i}` : "")} label="Preferred" />
                      <button type="button" onClick={() => {
                        if (preferredContactKey === `phone-${i}`) setPreferredContactKey("");
                        else if (preferredContactKey.startsWith("phone-")) { const oldIdx = parseInt(preferredContactKey.split("-")[1]); if (oldIdx > i) setPreferredContactKey(`phone-${oldIdx - 1}`); }
                        setPhones(phones.filter((_, j) => j !== i));
                      }} className="p-1 rounded-full text-muted-foreground hover:text-destructive cursor-pointer shrink-0"><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>
                  ))}
                  <Button type="button" variant="tonal" size="sm" onClick={() => setPhones([...phones, { phone: "", type: "mobile", is_primary: phones.length === 0 }])}>
                    <Plus className="h-4 w-4" /> Add phone
                  </Button>
                </div>

                {/* Tags */}
                <div className="pt-2 border-t border-outline-variant">
                  <label className={`${labelClasses} flex items-center gap-1.5 mb-3`}><Tag className="h-3.5 w-3.5" /> Tags</label>
                  {selectedTagIds.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {selectedTagIds.map((tagId) => {
                        const tag = allTags.find((t) => t.id === tagId);
                        return tag ? (
                          <span key={tagId} className="inline-flex items-center gap-1 h-7 pl-3 pr-1.5 rounded-full bg-secondary-container text-xs text-on-secondary-container font-medium">
                            {tag.name}
                            <button type="button" onClick={() => setSelectedTagIds(selectedTagIds.filter((id) => id !== tagId))} className="p-0.5 rounded-full hover:bg-on-secondary-container/10 cursor-pointer"><X className="h-3 w-3" /></button>
                          </span>
                        ) : null;
                      })}
                    </div>
                  )}
                  <div className="relative">
                    <input type="text" value={tagSearch} onChange={(e) => { setTagSearch(e.target.value); setShowTagDropdown(true); }} onFocus={() => setShowTagDropdown(true)} className={`${inputClasses} !h-11`} placeholder="Search or create tags…" />
                    {showTagDropdown && tagSearch.trim() && (
                      <div className="absolute z-50 mt-1 w-full bg-white rounded-[12px] border border-outline-variant shadow-lg max-h-48 overflow-y-auto py-1">
                        {allTags.filter((t) => t.name.toLowerCase().includes(tagSearch.toLowerCase()) && !selectedTagIds.includes(t.id)).map((tag) => (
                          <button key={tag.id} type="button" onClick={() => { setSelectedTagIds([...selectedTagIds, tag.id]); setTagSearch(""); setShowTagDropdown(false); }} className="w-full text-left px-4 py-2.5 text-sm text-foreground hover:bg-surface-container cursor-pointer">{tag.name}</button>
                        ))}
                        {!allTags.some((t) => t.name.toLowerCase() === tagSearch.trim().toLowerCase()) && (
                          <button type="button" onClick={async () => {
                            if (!user) return;
                            try {
                              const newTag = await createTag({ user_id: user.id, name: tagSearch.trim() } as any);
                              setAllTags([...allTags, newTag]);
                              setSelectedTagIds([...selectedTagIds, newTag.id]);
                              setTagSearch(""); setShowTagDropdown(false);
                            } catch {}
                          }} className="w-full text-left px-4 py-2.5 text-sm text-primary font-medium hover:bg-surface-container cursor-pointer">
                            Create &ldquo;{tagSearch.trim()}&rdquo;
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* LinkedIn */}
                <div className="pt-2 border-t border-outline-variant">
                  <label className={labelClasses}>LinkedIn URL</label>
                  <input type="url" value={formData.linkedin_url} onChange={(e) => setFormData({ ...formData, linkedin_url: e.target.value })} className={inputClasses} placeholder="https://linkedin.com/in/..." />
                </div>

                {/* Follow-up */}
                <div className="pt-2 border-t border-outline-variant">
                  <label className={labelClasses}>Follow-up frequency</label>
                  <Select
                    value={showCustomFrequency ? "custom" : FOLLOW_UP_OPTIONS.find((o) => o.days === Number(formData.follow_up_frequency_days)) ? formData.follow_up_frequency_days : formData.follow_up_frequency_days ? "custom" : ""}
                    onChange={(val) => {
                      if (val === "custom") { setShowCustomFrequency(true); setFormData({ ...formData, follow_up_frequency_days: "" }); }
                      else { setShowCustomFrequency(false); setFormData({ ...formData, follow_up_frequency_days: val }); }
                    }}
                    placeholder="No follow-up"
                    options={[{ value: "", label: "No follow-up" }, ...FOLLOW_UP_OPTIONS.map((o) => ({ value: o.days === -1 ? "custom" : String(o.days), label: o.label }))]}
                  />
                  {(showCustomFrequency || (formData.follow_up_frequency_days && !FOLLOW_UP_OPTIONS.find((o) => o.days === Number(formData.follow_up_frequency_days)))) && (
                    <input type="number" value={formData.follow_up_frequency_days} onChange={(e) => setFormData({ ...formData, follow_up_frequency_days: e.target.value })} className={`${inputClasses} mt-2`} placeholder="Number of days" min="1" autoFocus />
                  )}
                </div>

                {/* Notes */}
                <div className="pt-2 border-t border-outline-variant">
                  <label className={labelClasses}>Notes</label>
                  <textarea value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} className={`${inputClasses} !h-auto py-3`} rows={3} placeholder="Anything worth remembering…" />
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <Button type="button" variant="text" onClick={closeForm}>Cancel</Button>
                  <Button type="submit">Create</Button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
