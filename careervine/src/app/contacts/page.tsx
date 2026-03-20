"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useClickOutside } from "@/hooks/use-click-outside";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import Navigation from "@/components/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  getContacts, createContact, findOrCreateSchool, addSchoolToContact,
  findOrCreateCompany, addCompanyToContact,
  addEmailToContact, addPhoneToContact,
  getTags, createTag, addTagToContact, findOrCreateLocation,
} from "@/lib/queries";
import type { Contact, TagRow } from "@/lib/types";
import {
  Plus, Users, Search, ChevronDown, Mail, Phone,
  Tag, ExternalLink, Briefcase, GraduationCap, Check, Trash2, X,
} from "lucide-react";
import { SchoolAutocomplete } from "@/components/ui/school-autocomplete";
import { MonthYearPicker } from "@/components/ui/month-year-picker";
import { DegreeAutocomplete } from "@/components/ui/degree-autocomplete";
import { Select } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { inputClasses, labelClasses, FOLLOW_UP_OPTIONS } from "@/lib/form-styles";

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
  const [contacts, setContacts] = useState<Contact[]>([]);
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

  const loadContacts = useCallback(async () => {
    if (!user) return;
    try {
      const data = await getContacts(user.id);
      setContacts(data as Contact[]);
    } catch (error) {
      console.error("Error loading contacts:", error);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (user) {
      loadContacts();
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

  // Search suggestions: name-matches first, then tag-only matches
  const { nameSuggestions, tagSuggestions } = useMemo(() => {
    if (!searchQuery.trim()) return { nameSuggestions: [], tagSuggestions: [] };
    const q = searchQuery.toLowerCase();
    const nameHit = (c: Contact) =>
      c.name.toLowerCase().includes(q) ||
      c.contact_emails.some((e) => e.email?.toLowerCase().includes(q)) ||
      c.contact_companies.some((cc) => cc.companies.name.toLowerCase().includes(q) || cc.title?.toLowerCase().includes(q)) ||
      c.industry?.toLowerCase().includes(q);
    const tagHit = (c: Contact) => c.contact_tags.some((ct) => ct.tags.name.toLowerCase().includes(q));
    const nameSuggestions = contacts.filter(nameHit).slice(0, 5);
    const nameIds = new Set(nameSuggestions.map(c => c.id));
    const tagSuggestions = contacts.filter(c => !nameIds.has(c.id) && tagHit(c)).slice(0, 5);
    return { nameSuggestions, tagSuggestions };
  }, [contacts, searchQuery]);

  const filteredContacts = useMemo(() => {
    let result = contacts;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((c) =>
        c.name.toLowerCase().includes(q) ||
        c.industry?.toLowerCase().includes(q) ||
        c.contact_emails.some((e) => e.email?.toLowerCase().includes(q)) ||
        c.contact_companies.some((cc) => cc.companies.name.toLowerCase().includes(q) || cc.title?.toLowerCase().includes(q)) ||
        c.contact_tags.some((ct) => ct.tags.name.toLowerCase().includes(q))
      );
    }
    if (selectedTagFilter !== null) {
      result = result.filter((c) => c.contact_tags.some((ct) => ct.tag_id === selectedTagFilter));
    }
    return result;
  }, [contacts, searchQuery, selectedTagFilter]);

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

      closeForm();
      await loadContacts();
    } catch (error) {
      console.error("Error creating contact:", error);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="flex items-center gap-3 text-muted-foreground">
            <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
            <span className="text-sm">Loading contacts…</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-[28px] leading-9 font-normal text-foreground">Contacts</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {contacts.length} {contacts.length === 1 ? "person" : "people"} in your network
            </p>
          </div>
          <Button onClick={() => setShowForm(true)}>
            <Plus className="h-[18px] w-[18px]" /> Add contact
          </Button>
        </div>

        {/* Search bar + suggestions */}
        <div className="relative mb-4" ref={searchRef}>
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setShowSearchSuggestions(true); }}
            onFocus={() => setShowSearchSuggestions(true)}
            className="w-full h-12 pl-11 pr-4 bg-surface-container-low text-foreground rounded-full border border-outline-variant placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:border-2 transition-colors text-sm"
            placeholder="Search contacts…"
          />
          {showSearchSuggestions && searchQuery.trim() && (nameSuggestions.length > 0 || tagSuggestions.length > 0) && (
            <div className="absolute left-0 top-full mt-1.5 w-full z-50 bg-surface-container-high rounded-2xl shadow-lg border border-outline-variant overflow-hidden">
              {nameSuggestions.map((c) => {
                const currentCompany = c.contact_companies.find((cc) => cc.is_current);
                return (
                  <button key={c.id} type="button" onClick={() => { router.push(`/contacts/${c.id}`); setSearchQuery(""); }}
                    className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-surface-container cursor-pointer transition-colors text-left">
                    <div className="w-7 h-7 rounded-full bg-primary-container flex items-center justify-center shrink-0 text-on-primary-container text-xs font-medium">
                      {c.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-foreground truncate">{c.name}</p>
                      {currentCompany && <p className="text-xs text-muted-foreground truncate">{currentCompany.title}{currentCompany.title && currentCompany.companies.name ? " at " : ""}{currentCompany.companies.name}</p>}
                    </div>
                  </button>
                );
              })}
              {tagSuggestions.length > 0 && (
                <>
                  <p className="px-4 pt-2 pb-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wide border-t border-outline-variant/50">By tag</p>
                  {tagSuggestions.map((c) => {
                    const matchedTag = c.contact_tags.find(ct => ct.tags.name.toLowerCase().includes(searchQuery.toLowerCase()));
                    const currentCompany = c.contact_companies.find((cc) => cc.is_current);
                    return (
                      <button key={c.id} type="button" onClick={() => { router.push(`/contacts/${c.id}`); setSearchQuery(""); }}
                        className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-surface-container cursor-pointer transition-colors text-left">
                        <div className="w-7 h-7 rounded-full bg-primary-container flex items-center justify-center shrink-0 text-on-primary-container text-xs font-medium">
                          {c.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-foreground truncate">{c.name}</p>
                          {currentCompany && <p className="text-xs text-muted-foreground truncate">{currentCompany.title}{currentCompany.title && currentCompany.companies.name ? " at " : ""}{currentCompany.companies.name}</p>}
                        </div>
                        {matchedTag && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-surface-container text-muted-foreground shrink-0">{matchedTag.tags.name}</span>
                        )}
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          )}
        </div>

        {/* Empty state */}
        {contacts.length === 0 && (
          <Card variant="outlined" className="text-center py-16">
            <CardContent>
              <Users className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-base text-foreground mb-1">No contacts yet</p>
              <p className="text-sm text-muted-foreground mb-6">Add your first connection to get started.</p>
              <Button onClick={() => setShowForm(true)}>
                <Plus className="h-[18px] w-[18px]" /> Add contact
              </Button>
            </CardContent>
          </Card>
        )}

        {/* No search results */}
        {contacts.length > 0 && filteredContacts.length === 0 && (
          <p className="text-sm text-muted-foreground py-8 text-center">No contacts match your search.</p>
        )}

        {/* Contact list */}
        <div className="space-y-1.5">
          {filteredContacts.map((contact) => {
            const isExpanded = expandedId === contact.id;
            const currentCompany = contact.contact_companies.find((cc) => cc.is_current);
            const primaryEmail = contact.contact_emails.find((e) => e.is_primary) || contact.contact_emails[0];

            return (
              <div key={contact.id} className="rounded-[12px] border border-outline-variant/60 bg-white hover:border-outline-variant hover:shadow-sm transition-all">
                <div
                  className="flex items-center gap-3 p-3.5 cursor-pointer"
                  onClick={() => router.push(`/contacts/${contact.id}`)}
                >
                  {/* Avatar */}
                  <div className="w-10 h-10 rounded-full bg-primary-container flex items-center justify-center shrink-0 text-on-primary-container text-sm font-medium">
                    {contact.name.charAt(0).toUpperCase()}
                  </div>

                  {/* Name + subtitle */}
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-medium text-foreground truncate">{contact.name}</h3>
                    <p className="text-xs text-muted-foreground truncate">
                      {currentCompany
                        ? `${currentCompany.title || ""}${currentCompany.title && currentCompany.companies.name ? " at " : ""}${currentCompany.companies.name}`
                        : contact.industry || "No details"
                      }
                    </p>
                  </div>

                  {/* Email chip */}
                  {primaryEmail && (
                    <span className="hidden sm:inline-flex items-center gap-1 text-xs text-muted-foreground truncate max-w-[180px]">
                      <Mail className="h-3 w-3 shrink-0" />
                      {primaryEmail.email}
                    </span>
                  )}

                  {/* Status badge — Student or Professional only */}
                  {contact.contact_status && (
                    <span className="hidden md:inline-flex text-[10px] px-2 py-0.5 rounded-full bg-secondary-container text-on-secondary-container font-medium capitalize">
                      {contact.contact_status}
                    </span>
                  )}

                  {/* Expand chevron — stops propagation so bar click doesn't navigate */}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setExpandedId(isExpanded ? null : contact.id); }}
                    className="group p-1.5 rounded-full text-muted-foreground hover:text-foreground cursor-pointer transition-colors shrink-0"
                    title="Quick preview"
                  >
                    <ChevronDown className={`h-4 w-4 transition-transform duration-200 ${isExpanded ? "rotate-0" : "-rotate-90 group-hover:rotate-0"}`} />
                  </button>
                </div>

                {/* Expanded preview */}
                {isExpanded && (
                  <div className="px-3.5 pb-3.5 pt-0 border-t border-outline-variant/30">
                    <div className="pt-2.5 space-y-2">
                      {/* Contact info chips */}
                      <div className="flex flex-wrap gap-1.5">
                        {contact.contact_emails.map((email) => (
                          <span key={email.id} className="inline-flex items-center gap-1 text-xs text-foreground bg-surface-container-low px-2 py-1 rounded-md">
                            <Mail className="h-3 w-3 text-muted-foreground" /> {email.email}
                            {email.is_primary && <span className="text-primary font-medium text-[10px]">·primary</span>}
                          </span>
                        ))}
                        {contact.contact_phones.map((phone) => (
                          <span key={phone.id} className="inline-flex items-center gap-1 text-xs text-foreground bg-surface-container-low px-2 py-1 rounded-md">
                            <Phone className="h-3 w-3 text-muted-foreground" /> {phone.phone}
                          </span>
                        ))}
                        {contact.linkedin_url && (
                          <a href={contact.linkedin_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary bg-surface-container-low px-2 py-1 rounded-md hover:underline">
                            <ExternalLink className="h-3 w-3" /> LinkedIn
                          </a>
                        )}
                      </div>

                      {/* Companies */}
                      {contact.contact_companies.length > 0 && (
                        <div className="space-y-0.5">
                          {contact.contact_companies.map((cc) => (
                            <p key={cc.id} className="text-xs text-muted-foreground">
                              <Briefcase className="h-3 w-3 inline mr-1" />
                              {cc.title}{cc.title && cc.companies.name ? " at " : ""}{cc.companies.name}
                              {cc.is_current && <span className="text-primary font-medium ml-1">· Current</span>}
                            </p>
                          ))}
                        </div>
                      )}

                      {/* School */}
                      {contact.contact_schools.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          <GraduationCap className="h-3 w-3 inline mr-1" />
                          {contact.contact_schools[0].degree}{contact.contact_schools[0].field_of_study ? ` in ${contact.contact_schools[0].field_of_study}` : ""} · {contact.contact_schools[0].schools.name}
                        </p>
                      )}

                      {contact.notes && (
                        <p className="text-xs text-muted-foreground line-clamp-2">{contact.notes}</p>
                      )}

                      <Button
                        variant="tonal"
                        size="sm"
                        onClick={() => router.push(`/contacts/${contact.id}`)}
                      >
                        View full profile
                      </Button>
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
                    <input type="text" value={formData.location_state} onChange={(e) => setFormData({ ...formData, location_state: e.target.value })} className={inputClasses} placeholder="e.g. CA" />
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
