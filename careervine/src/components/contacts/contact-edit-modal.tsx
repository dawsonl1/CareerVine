"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useClickOutside } from "@/hooks/use-click-outside";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { SchoolAutocomplete } from "@/components/ui/school-autocomplete";
import { MonthYearPicker } from "@/components/ui/month-year-picker";
import { DegreeAutocomplete } from "@/components/ui/degree-autocomplete";
import { Modal } from "@/components/ui/modal";
import {
  updateContact, deleteContact, findOrCreateSchool, addSchoolToContact,
  removeSchoolsFromContact, findOrCreateCompany, addCompanyToContact,
  removeCompaniesFromContact, removeEmailsFromContact, addEmailToContact,
  removePhonesFromContact, addPhoneToContact, getTags, createTag,
  addTagToContact, removeTagFromContact, findOrCreateLocation,
} from "@/lib/queries";
import type { Contact, TagRow } from "@/lib/types";
import {
  Plus, X, Check, Mail, Phone,
  Tag, Briefcase, GraduationCap, Trash2,
} from "lucide-react";
import { inputClasses, labelClasses, FOLLOW_UP_OPTIONS } from "@/lib/form-styles";

type CompanyEntry = { company_name: string; title: string; location?: string; is_current: boolean; start_month: string; end_month: string };

interface ContactEditModalProps {
  isOpen: boolean;
  contact: Contact;
  userId: string;
  onClose: () => void;
  onContactUpdate: () => void;
  onContactDelete: () => void;
}

export function ContactEditModal({ isOpen, contact, userId, onClose, onContactUpdate, onContactDelete }: ContactEditModalProps) {
  const { success: toastSuccess, error: toastError } = useToast();

  const [formData, setFormData] = useState({
    name: "", industry: "", linkedin_url: "", notes: "", met_through: "",
    follow_up_frequency_days: "", contact_status: "", expected_graduation: "",
    school_name: "", degree: "", field_of_study: "",
    location_city: "", location_state: "", location_country: "United States",
  });
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
  const tagDropdownRef = useRef<HTMLDivElement>(null);
  useClickOutside(tagDropdownRef, useCallback(() => setShowTagDropdown(false), []), showTagDropdown);

  useEffect(() => {
    getTags(userId).then(setAllTags).catch(() => {});
  }, [userId]);

  // Populate form when modal opens
  useEffect(() => {
    if (!isOpen) return;
    const schoolInfo = contact.contact_schools?.[0];
    setFormData({
      name: contact.name,
      industry: contact.industry || "",
      linkedin_url: contact.linkedin_url || "",
      notes: contact.notes || "",
      met_through: contact.met_through || "",
      follow_up_frequency_days: contact.follow_up_frequency_days?.toString() || "",
      contact_status: contact.contact_status || "",
      expected_graduation: contact.expected_graduation || "",
      school_name: schoolInfo?.schools?.name || "",
      degree: schoolInfo?.degree || "",
      field_of_study: schoolInfo?.field_of_study || "",
      location_city: contact.locations?.city || "",
      location_state: contact.locations?.state || "",
      location_country: contact.locations?.country || "United States",
    });
    setCompanies(
      contact.contact_companies.length > 0
        ? contact.contact_companies.map((cc) => ({
            company_name: cc.companies.name,
            title: cc.title || "",
            location: (cc as any).location || "",
            is_current: cc.is_current,
            start_month: (cc as any).start_month || "",
            end_month: (cc as any).end_month || "",
          }))
        : []
    );
    setEmails(
      contact.contact_emails.length > 0
        ? contact.contact_emails.map((e) => ({ email: e.email || "", is_primary: e.is_primary }))
        : []
    );
    setPhones(
      contact.contact_phones.length > 0
        ? contact.contact_phones.map((p) => ({ phone: p.phone, type: p.type, is_primary: p.is_primary }))
        : []
    );
    if (contact.preferred_contact_method && contact.preferred_contact_value) {
      if (contact.preferred_contact_method === "email") {
        const idx = contact.contact_emails.findIndex((e) => e.email === contact.preferred_contact_value);
        setPreferredContactKey(idx >= 0 ? `email-${idx}` : "");
      } else if (contact.preferred_contact_method === "phone") {
        const idx = contact.contact_phones.findIndex((p) => p.phone === contact.preferred_contact_value);
        setPreferredContactKey(idx >= 0 ? `phone-${idx}` : "");
      } else {
        setPreferredContactKey("");
      }
    } else {
      setPreferredContactKey("");
    }
    setSelectedTagIds(contact.contact_tags.map((ct) => ct.tag_id));
    setShowEducation(!!schoolInfo);
    const freq = contact.follow_up_frequency_days;
    setShowCustomFrequency(!!freq && !FOLLOW_UP_OPTIONS.some((o) => o.days === freq));
  }, [isOpen, contact]);

  const handleSave = async () => {
    try {
      const contactData = {
        user_id: userId,
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

      await updateContact(contact.id, contactData);

      await removeCompaniesFromContact(contact.id);
      for (const entry of companies) {
        if (entry.company_name.trim()) {
          const company = await findOrCreateCompany(entry.company_name.trim());
          await addCompanyToContact({
            contact_id: contact.id,
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
        await removeSchoolsFromContact(contact.id);
        const school = await findOrCreateSchool(formData.school_name.trim());
        await addSchoolToContact({
          contact_id: contact.id,
          school_id: school.id,
          degree: formData.degree || null,
          field_of_study: formData.field_of_study || null,
          start_year: null,
          end_year: null,
        });
      } else {
        await removeSchoolsFromContact(contact.id);
      }

      await removeEmailsFromContact(contact.id);
      for (const entry of emails) {
        if (entry.email.trim()) {
          await addEmailToContact(contact.id, entry.email.trim(), entry.is_primary);
        }
      }

      await removePhonesFromContact(contact.id);
      for (const entry of phones) {
        if (entry.phone.trim()) {
          await addPhoneToContact(contact.id, entry.phone.trim(), entry.type || "mobile", entry.is_primary);
        }
      }

      const oldTagIds = contact.contact_tags.map((ct) => ct.tag_id);
      const toAdd = selectedTagIds.filter((id) => !oldTagIds.includes(id));
      const toRemove = oldTagIds.filter((id) => !selectedTagIds.includes(id));
      for (const tagId of toAdd) await addTagToContact(contact.id, tagId);
      for (const tagId of toRemove) await removeTagFromContact(contact.id, tagId);

      onClose();
      onContactUpdate();
      toastSuccess("Contact saved");
    } catch {
      toastError("Failed to save contact");
    }
  };

  const handleDelete = async () => {
    if (!confirm("Are you sure you want to delete this contact?")) return;
    try {
      await deleteContact(contact.id);
      onContactDelete();
      toastSuccess("Contact deleted");
    } catch {
      toastError("Failed to delete contact");
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Edit contact" size="lg">
      <form
        onSubmit={async (e) => { e.preventDefault(); await handleSave(); }}
        className="px-6 pb-6 space-y-4"
      >
        {/* Basics */}
        <div>
          <label className={labelClasses}>Name *</label>
          <input type="text" required value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} className={inputClasses} placeholder="Full name" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClasses}>Status</label>
            <div className="inline-flex rounded-full border border-outline overflow-hidden">
              {([{ value: "student", label: "Student" }, { value: "professional", label: "Professional" }] as const).map((opt, idx) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    const newStatus = formData.contact_status === opt.value ? "" : opt.value;
                    setFormData({ ...formData, contact_status: newStatus });
                    if (opt.value === "student" && newStatus === "student") setShowEducation(true);
                    else if (newStatus !== "student") {
                      const hasEd = formData.school_name.trim() || formData.degree.trim() || formData.field_of_study.trim();
                      if (!hasEd) setShowEducation(false);
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
                    <button
                      key={type}
                      type="button"
                      onClick={() => { const u = [...companies]; u[i] = { ...u[i], is_current: type === "current" }; setCompanies(u); }}
                      className={`h-8 px-3 rounded-full text-xs font-medium cursor-pointer transition-colors border ${
                        (type === "current" ? entry.is_current : !entry.is_current)
                          ? "bg-secondary-container text-on-secondary-container border-secondary-container"
                          : "bg-transparent text-foreground border-outline-variant hover:bg-surface-container"
                      }`}
                    >
                      {type === "current" ? "Current" : "Past"}
                    </button>
                  ))}
                </div>
                <button type="button" onClick={() => setCompanies(companies.filter((_, j) => j !== i))} className="p-1 rounded-full text-muted-foreground hover:text-destructive cursor-pointer">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input type="text" value={entry.company_name} onChange={(e) => { const u = [...companies]; u[i] = { ...u[i], company_name: e.target.value }; setCompanies(u); }} className={`${inputClasses} !h-11`} placeholder="Company name" />
                <input type="text" value={entry.title} onChange={(e) => { const u = [...companies]; u[i] = { ...u[i], title: e.target.value }; setCompanies(u); }} className={`${inputClasses} !h-11`} placeholder="Job title" />
              </div>
              <input type="text" value={entry.location} onChange={(e) => { const u = [...companies]; u[i] = { ...u[i], location: e.target.value }; setCompanies(u); }} className={`${inputClasses} !h-11`} placeholder="Location (e.g., San Francisco, CA)" />
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
              }} className="p-1 rounded-full text-muted-foreground hover:text-destructive cursor-pointer shrink-0">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
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
              }} className="p-1 rounded-full text-muted-foreground hover:text-destructive cursor-pointer shrink-0">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
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
                    <button type="button" onClick={() => setSelectedTagIds(selectedTagIds.filter((id) => id !== tagId))} className="p-0.5 rounded-full hover:bg-on-secondary-container/10 cursor-pointer">
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ) : null;
              })}
            </div>
          )}
          <div className="relative" ref={tagDropdownRef}>
            <input
              type="text"
              value={tagSearch}
              onChange={(e) => { setTagSearch(e.target.value); setShowTagDropdown(true); }}
              onFocus={() => setShowTagDropdown(true)}
              className={`${inputClasses} !h-11`}
              placeholder="Search or create tags..."
            />
            {showTagDropdown && tagSearch.trim() && (
              <div className="absolute z-50 mt-1 w-full bg-white rounded-[12px] border border-outline-variant shadow-lg max-h-48 overflow-y-auto py-1">
                {allTags
                  .filter((t) => t.name.toLowerCase().includes(tagSearch.toLowerCase()) && !selectedTagIds.includes(t.id))
                  .map((tag) => (
                    <button key={tag.id} type="button" onClick={() => { setSelectedTagIds([...selectedTagIds, tag.id]); setTagSearch(""); setShowTagDropdown(false); }} className="w-full text-left px-4 py-2.5 text-sm text-foreground hover:bg-surface-container cursor-pointer">
                      {tag.name}
                    </button>
                  ))}
                {!allTags.some((t) => t.name.toLowerCase() === tagSearch.trim().toLowerCase()) && (
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const newTag = await createTag({ user_id: userId, name: tagSearch.trim() } as any);
                        setAllTags([...allTags, newTag]);
                        setSelectedTagIds([...selectedTagIds, newTag.id]);
                        setTagSearch("");
                        setShowTagDropdown(false);
                      } catch {}
                    }}
                    className="w-full text-left px-4 py-2.5 text-sm text-primary font-medium hover:bg-surface-container cursor-pointer"
                  >
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

        {/* Follow-up frequency */}
        <div className="pt-2 border-t border-outline-variant">
          <label className={labelClasses}>Follow-up frequency</label>
          <Select
            value={
              showCustomFrequency ? "custom"
              : FOLLOW_UP_OPTIONS.find((o) => o.days === Number(formData.follow_up_frequency_days)) ? formData.follow_up_frequency_days
              : formData.follow_up_frequency_days ? "custom"
              : ""
            }
            onChange={(val) => {
              if (val === "custom") { setShowCustomFrequency(true); setFormData({ ...formData, follow_up_frequency_days: "" }); }
              else { setShowCustomFrequency(false); setFormData({ ...formData, follow_up_frequency_days: val }); }
            }}
            placeholder="No follow-up"
            options={[
              { value: "", label: "No follow-up" },
              ...FOLLOW_UP_OPTIONS.map((o) => ({ value: o.days === -1 ? "custom" : String(o.days), label: o.label })),
            ]}
          />
          {(showCustomFrequency || (formData.follow_up_frequency_days && !FOLLOW_UP_OPTIONS.find((o) => o.days === Number(formData.follow_up_frequency_days)))) && (
            <input
              type="number"
              value={formData.follow_up_frequency_days}
              onChange={(e) => setFormData({ ...formData, follow_up_frequency_days: e.target.value })}
              className={`${inputClasses} mt-2`}
              placeholder="Number of days"
              min="1"
              autoFocus
            />
          )}
        </div>

        {/* Notes */}
        <div className="pt-2 border-t border-outline-variant">
          <label className={labelClasses}>Notes</label>
          <textarea value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} className={`${inputClasses} !h-auto py-3`} rows={3} placeholder="Anything worth remembering..." />
        </div>

        <div className="flex items-center justify-between pt-2">
          <button
            type="button"
            onClick={handleDelete}
            className="text-sm text-destructive hover:underline cursor-pointer"
          >
            Delete contact
          </button>
          <div className="flex gap-2">
            <Button type="button" variant="text" onClick={onClose}>Cancel</Button>
            <Button type="submit">Save</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
