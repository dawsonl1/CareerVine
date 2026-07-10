"use client";

import { useState, useRef, useCallback, type ChangeEvent } from "react";
import { useClickOutside } from "@/hooks/use-click-outside";
import { useToast } from "@/components/ui/toast";
import { useCompose } from "@/components/compose-email-context";
import {
  Mail, Phone, ExternalLink, MapPin, Clock, Send,
  Pencil, Trash2, ChevronDown, Check, UserPlus, RefreshCw, MailSearch,
  Link2, AlertTriangle,
} from "lucide-react";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { ResolveLinkedinModal } from "@/components/contacts/resolve-linkedin-modal";
import { SCRAPE_FAILURES_BEFORE_RELINK } from "@/lib/constants";
import {
  updateContact,
  addEmailToContact,
  removeEmailsFromContact,
  activateContact,
  uploadContactPhoto,
  removeContactPhoto,
} from "@/lib/queries";
import { validateContactPhotoFile } from "@/lib/contact-photo";
import { FOLLOW_UP_OPTIONS } from "@/lib/form-styles";
import type { Contact } from "@/lib/types";

interface ContactProfileCardProps {
  contact: Contact;
  userId: string;
  onEdit: () => void;
  onDelete: () => void;
  onContactUpdate: () => void;
}

const CADENCE_OPTIONS = [
  { label: "No follow-up", days: null },
  ...FOLLOW_UP_OPTIONS.filter((o) => o.days !== -1).map((o) => ({ label: o.label, days: o.days })),
];

export function ContactProfileCard({
  contact,
  userId,
  onEdit,
  onDelete,
  onContactUpdate,
}: ContactProfileCardProps) {
  const { gmailConnected, openCompose } = useCompose();
  const { success: toastSuccess, error: toastError } = useToast();

  // Inline email editing
  const [editingEmail, setEditingEmail] = useState(false);
  const [emailValue, setEmailValue] = useState("");
  const emailInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [photoBusy, setPhotoBusy] = useState(false);

  // Cadence dropdown
  const [cadenceOpen, setCadenceOpen] = useState(false);
  const cadenceRef = useRef<HTMLDivElement>(null);
  useClickOutside(cadenceRef, useCallback(() => setCadenceOpen(false), []), cadenceOpen);

  const currentCompany = contact.contact_companies.find((cc) => cc.is_current);
  const primaryEmail =
    contact.contact_emails.find((e) => e.is_primary)?.email ||
    contact.contact_emails[0]?.email;
  const primaryPhone =
    contact.contact_phones.find((p) => p.is_primary) ||
    contact.contact_phones[0];
  const locationParts = [
    contact.locations?.city,
    contact.locations?.state,
    contact.locations?.country,
  ].filter(Boolean);

  const cadenceLabel = contact.follow_up_frequency_days
    ? CADENCE_OPTIONS.find((o) => o.days === contact.follow_up_frequency_days)?.label ||
      `${contact.follow_up_frequency_days} days`
    : "No follow-up";

  const startEmailEdit = () => {
    setEmailValue(primaryEmail || "");
    setEditingEmail(true);
    setTimeout(() => emailInputRef.current?.focus(), 0);
  };

  const saveEmail = async () => {
    setEditingEmail(false);
    const trimmed = emailValue.trim();
    if (trimmed === (primaryEmail || "")) return;

    try {
      await removeEmailsFromContact(contact.id);
      if (trimmed) {
        await addEmailToContact(contact.id, trimmed, true);
      }
      // Re-add other emails
      for (const e of contact.contact_emails) {
        if (e.email && e.email !== primaryEmail) {
          await addEmailToContact(contact.id, e.email, e.is_primary && !trimmed);
        }
      }
      onContactUpdate();
      toastSuccess("Email updated");
    } catch {
      toastError("Failed to update email");
    }
  };

  const handleActivate = async () => {
    try {
      await activateContact(contact.id);
      onContactUpdate();
      toastSuccess(`${contact.name} added to your network`);
    } catch {
      toastError("Failed to add to network");
    }
  };

  // ── LinkedIn re-scrape / find-email (plan 29) ──
  const [scraping, setScraping] = useState(false);
  const handleScrape = async (mode: "profile" | "email") => {
    if (scraping) return;
    setScraping(true);
    try {
      const res = await fetch(`/api/contacts/${contact.id}/scrape`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toastError("Couldn't start the refresh");
      } else if (data.status === "started") {
        toastSuccess(mode === "email" ? "Searching LinkedIn for an email…" : "Refreshing from LinkedIn…");
      } else if (data.status === "pending") {
        toastSuccess("A refresh is already in progress");
      } else if (data.status === "debounced") {
        toastSuccess("Already refreshed in the last few days");
      } else if (data.status === "cap_reached") {
        toastError("Monthly scrape budget reached");
      } else if (data.status === "no_url") {
        toastError("This contact has no LinkedIn URL to scrape");
      } else if (data.status === "disabled") {
        toastError("Scraping isn't configured yet");
      }
    } catch {
      toastError("Couldn't start the refresh");
    } finally {
      setScraping(false);
    }
  };

  const dataAsOf = contact.last_scraped_at
    ? `Data as of ${new Date(contact.last_scraped_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
    : null;

  // LinkedIn resolve/re-link modal (plan 29 §6.3)
  const [resolveOpen, setResolveOpen] = useState(false);
  const linkLooksBroken =
    Boolean(contact.linkedin_url) &&
    (contact.scrape_failure_count ?? 0) >= SCRAPE_FAILURES_BEFORE_RELINK;

  const saveCadence = async (days: number | null) => {
    setCadenceOpen(false);
    if (days === contact.follow_up_frequency_days) return;
    try {
      await updateContact(contact.id, {
        follow_up_frequency_days: days,
        user_id: userId,
      });
      onContactUpdate();
      toastSuccess("Follow-up cadence updated");
    } catch {
      toastError("Failed to update cadence");
    }
  };

  const handlePhotoUploadClick = () => {
    if (!photoBusy) photoInputRef.current?.click();
  };

  const handlePhotoSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const validationError = validateContactPhotoFile(file);
    if (validationError) {
      toastError(validationError);
      return;
    }

    setPhotoBusy(true);
    try {
      await uploadContactPhoto(userId, contact.id, file);
      onContactUpdate();
      toastSuccess("Profile photo updated");
    } catch {
      toastError("Failed to upload profile photo");
    } finally {
      setPhotoBusy(false);
    }
  };

  const handlePhotoRemove = async () => {
    if (!contact.photo_url || photoBusy) return;
    setPhotoBusy(true);
    try {
      await removeContactPhoto(userId, contact.id);
      onContactUpdate();
      toastSuccess("Profile photo removed");
    } catch {
      toastError("Failed to remove profile photo");
    } finally {
      setPhotoBusy(false);
    }
  };

  return (
    <div className="rounded-[16px] border border-outline-variant p-6">
      {/* Profile hero */}
      <div className="flex flex-col items-center text-center">
        <ContactAvatar
          name={contact.name}
          photoUrl={contact.photo_url}
          className={`w-[88px] h-[88px] text-[28px] mb-4 ${contact.network_status === "bench" ? "grayscale opacity-75" : ""}`}
          ringClassName={
            contact.network_status === "prospect"
              ? "ring-teal-500 ring-offset-2"
              : contact.network_status === "bench"
                ? "ring-outline ring-offset-2"
                : ""
          }
        />
        <input
          ref={photoInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          className="hidden"
          onChange={handlePhotoSelected}
        />
        <div className="mb-4 flex items-center gap-3">
          <button
            type="button"
            onClick={handlePhotoUploadClick}
            disabled={photoBusy}
            className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50 cursor-pointer"
          >
            {photoBusy ? "Uploading..." : "Upload photo"}
          </button>
          {contact.photo_url && (
            <button
              type="button"
              onClick={handlePhotoRemove}
              disabled={photoBusy}
              className="text-xs text-muted-foreground hover:text-destructive disabled:opacity-50 cursor-pointer"
            >
              Remove
            </button>
          )}
        </div>
        <div className="flex items-center gap-2.5">
          <h1 className="text-xl font-medium text-foreground">{contact.name}</h1>
          {contact.contact_status && (
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-secondary-container text-on-secondary-container font-medium capitalize">
              {contact.contact_status}
            </span>
          )}
          {contact.network_status !== "active" && (
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-tertiary-container text-on-tertiary-container font-medium">
              {contact.network_status === "prospect" ? "Prospect" : "Imported"}
            </span>
          )}
        </div>
        {currentCompany && (
          <p className="text-base text-muted-foreground mt-0.5">
            {currentCompany.title}
            {currentCompany.title && currentCompany.companies.name ? " at " : ""}
            {currentCompany.companies.name}
          </p>
        )}
        {contact.industry && !currentCompany && (
          <p className="text-base text-muted-foreground mt-0.5">{contact.industry}</p>
        )}
        {locationParts.length > 0 && (
          <p className="text-sm text-muted-foreground flex items-center gap-1.5 mt-1">
            <MapPin className="h-3.5 w-3.5" />
            {locationParts.join(", ")}
          </p>
        )}

        {/* Prospect/bench → one click into the active network */}
        {contact.network_status !== "active" && (
          <button
            onClick={handleActivate}
            className="state-layer mt-4 w-full h-10 rounded-full bg-primary text-primary-foreground text-sm font-medium cursor-pointer inline-flex items-center justify-center gap-2 shadow-sm hover:shadow-md transition-all"
          >
            <UserPlus className="h-4 w-4" /> Add to my network
          </button>
        )}
      </div>

      {/* Contact info section */}
      <div className="mt-5 pt-5 border-t border-outline-variant space-y-3">
        {/* Email — inline editable */}
        <div className="flex items-center gap-3 text-base group">
          <Mail className="h-5 w-5 text-muted-foreground shrink-0" />
          {editingEmail ? (
            <input
              ref={emailInputRef}
              type="email"
              value={emailValue}
              onChange={(e) => setEmailValue(e.target.value)}
              onBlur={saveEmail}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveEmail();
                if (e.key === "Escape") setEditingEmail(false);
              }}
              className="flex-1 min-w-0 text-base bg-white rounded-[4px] px-1.5 py-0.5 -mx-1.5 -my-0.5 focus:outline-none shadow-[0_0_0_1.5px_var(--primary)]"
              placeholder="Add email..."
            />
          ) : (
            <button
              onClick={startEmailEdit}
              className="flex-1 min-w-0 text-left truncate text-foreground rounded-[4px] px-1.5 py-0.5 -mx-1.5 -my-0.5 transition-colors duration-150 hover:bg-black/[0.04] cursor-pointer"
              title="Click to edit email"
            >
              {primaryEmail || (
                <span className="text-muted-foreground italic">Add email...</span>
              )}
            </button>
          )}
          {gmailConnected && primaryEmail && !editingEmail && (
            <button
              onClick={() => openCompose({ to: primaryEmail, name: contact.name })}
              className="p-1 rounded-full text-muted-foreground hover:text-primary transition-colors cursor-pointer opacity-0 group-hover:opacity-100"
              title="Send email"
            >
              <Send className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Phone */}
        {primaryPhone && (
          <div className="flex items-center gap-3 text-base">
            <Phone className="h-5 w-5 text-muted-foreground shrink-0" />
            <span className="text-foreground">{primaryPhone.phone}</span>
            <span className="text-sm text-muted-foreground capitalize">{primaryPhone.type}</span>
          </div>
        )}

        {/* LinkedIn */}
        {contact.linkedin_url ? (
          <div className="flex items-center gap-3 text-base">
            <ExternalLink className="h-5 w-5 text-muted-foreground shrink-0" />
            <a
              href={contact.linkedin_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline truncate"
            >
              LinkedIn
            </a>
            {linkLooksBroken && (
              <button
                onClick={() => setResolveOpen(true)}
                className="flex items-center gap-1 text-xs text-amber-600 hover:underline cursor-pointer"
                title="Recent refreshes failed — the profile may have moved"
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                Re-link
              </button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-3 text-base">
            <Link2 className="h-5 w-5 text-muted-foreground shrink-0" />
            <button
              onClick={() => setResolveOpen(true)}
              className="text-primary hover:underline cursor-pointer text-left"
            >
              Link LinkedIn profile
            </button>
          </div>
        )}

        {/* Scrape freshness (plan 29) */}
        {dataAsOf && (
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Clock className="h-4 w-4 shrink-0" />
            <span>{dataAsOf}</span>
          </div>
        )}

        {/* Follow-up cadence — inline dropdown */}
        <div className="flex items-center gap-3 text-base relative" ref={cadenceRef}>
          <Clock className="h-5 w-5 text-muted-foreground shrink-0" />
          <button
            onClick={() => setCadenceOpen(!cadenceOpen)}
            className="flex items-center gap-1 text-left rounded-[4px] px-1.5 py-0.5 -mx-1.5 -my-0.5 transition-colors duration-150 hover:bg-black/[0.04] cursor-pointer"
          >
            <span className={contact.follow_up_frequency_days ? "text-foreground" : "text-muted-foreground italic"}>
              {cadenceLabel}
            </span>
            <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform ${cadenceOpen ? "rotate-180" : ""}`} />
          </button>

          {cadenceOpen && (
            <div className="absolute left-6 top-full mt-1 z-50 w-48 bg-white rounded-[12px] border border-outline-variant shadow-lg py-1">
              {CADENCE_OPTIONS.map((opt) => {
                const isSelected = opt.days === contact.follow_up_frequency_days ||
                  (opt.days === null && !contact.follow_up_frequency_days);
                return (
                  <button
                    key={opt.label}
                    onClick={() => saveCadence(opt.days)}
                    className={`w-full text-left px-5 py-2.5 text-base cursor-pointer transition-colors flex items-center justify-between ${
                      isSelected
                        ? "text-primary bg-primary-container/30 font-medium"
                        : "text-foreground hover:bg-surface-container"
                    }`}
                  >
                    {opt.label}
                    {isSelected && <Check className="h-3.5 w-3.5" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Footer actions */}
      <div className="flex justify-center gap-1.5 mt-5 pt-5 border-t border-outline-variant">
        {contact.linkedin_url && (
          <button
            onClick={() => handleScrape("profile")}
            disabled={scraping}
            className="p-2.5 rounded-full text-muted-foreground hover:text-primary cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-default"
            title="Refresh from LinkedIn"
          >
            <RefreshCw className={`h-5 w-5 ${scraping ? "animate-spin" : ""}`} />
          </button>
        )}
        {contact.linkedin_url && !primaryEmail && (
          <button
            onClick={() => handleScrape("email")}
            disabled={scraping}
            className="p-2.5 rounded-full text-muted-foreground hover:text-primary cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-default"
            title="Find email on LinkedIn"
          >
            <MailSearch className="h-5 w-5" />
          </button>
        )}
        <button
          onClick={onEdit}
          className="p-2.5 rounded-full text-muted-foreground hover:text-primary cursor-pointer transition-colors"
          title="Edit contact"
        >
          <Pencil className="h-5 w-5" />
        </button>
        <button
          onClick={onDelete}
          className="p-2.5 rounded-full text-muted-foreground hover:text-destructive cursor-pointer transition-colors"
          title="Delete contact"
        >
          <Trash2 className="h-5 w-5" />
        </button>
      </div>

      {resolveOpen && (
        <ResolveLinkedinModal
          contactId={contact.id}
          contactName={contact.name}
          onClose={() => setResolveOpen(false)}
          onLinked={onContactUpdate}
        />
      )}
    </div>
  );
}
