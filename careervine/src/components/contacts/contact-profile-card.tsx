"use client";

import { useState, useRef, useCallback } from "react";
import { useClickOutside } from "@/hooks/use-click-outside";
import { useToast } from "@/components/ui/toast";
import { useCompose } from "@/components/compose-email-context";
import {
  Mail, Phone, ExternalLink, MapPin, Clock, Send,
  Pencil, Trash2, ChevronDown, Check,
} from "lucide-react";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { updateContact, addEmailToContact, removeEmailsFromContact } from "@/lib/queries";
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

  return (
    <div className="rounded-[16px] border border-outline-variant p-6">
      {/* Profile hero */}
      <div className="flex flex-col items-center text-center">
        <ContactAvatar
          name={contact.name}
          photoUrl={contact.photo_url}
          className="w-[88px] h-[88px] text-[28px] mb-4"
        />
        <div className="flex items-center gap-2.5">
          <h1 className="text-xl font-medium text-foreground">{contact.name}</h1>
          {contact.contact_status && (
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-secondary-container text-on-secondary-container font-medium capitalize">
              {contact.contact_status}
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
        {contact.linkedin_url && (
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
    </div>
  );
}
