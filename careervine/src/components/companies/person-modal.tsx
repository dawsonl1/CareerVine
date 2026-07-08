"use client";

/**
 * Person popup for the outreach flow (plan 25): the full picture of one
 * contact — why the pipeline kept them, their history, education, and
 * email provenance — with "Write email" as the primary action.
 */

import { useState, useEffect } from "react";
import Link from "next/link";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { getContactById } from "@/lib/queries";
import type { Contact } from "@/lib/types";
import { setStageOverride, type CompanyPerson } from "@/lib/company-queries";
import { STAGE_LABELS, type OutreachStage } from "@/lib/stage-derivation";
import { ExternalLink, GraduationCap, MapPin, Mail, AlertTriangle, Briefcase, Check } from "lucide-react";

const PERSONA_LABELS: Record<string, string> = {
  alum_product: "Alum · Product",
  alum_other: "Alum",
  product_peer: "Product peer",
  product_leader: "Product leader",
  recruiter: "Recruiter",
};

interface PersonModalProps {
  person: CompanyPerson;
  companyId: number;
  companyName: string;
  userId: string;
  onClose: () => void;
  /** Open the compose modal prefilled; the popup closes itself first. */
  onWriteEmail: (person: CompanyPerson) => void;
  /** Called after a state change (e.g. mark contacted) so the parent can refresh. */
  onChanged?: () => void;
}

export function PersonModal({ person, companyId, companyName, userId, onClose, onWriteEmail, onChanged }: PersonModalProps) {
  const [contact, setContact] = useState<Contact | null>(null);
  const [markedContacted, setMarkedContacted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getContactById(person.contact_id, userId)
      .then((c) => {
        if (!cancelled) setContact(c as Contact);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [person.contact_id, userId]);

  const rolesHere = person.roles;
  const otherRoles = (contact?.contact_companies ?? [])
    .filter((cc) => cc.company_id !== companyId)
    .sort((a, b) => Number(b.is_current) - Number(a.is_current) || (b.start_month ?? "").localeCompare(a.start_month ?? ""))
    .slice(0, 5);
  const education = contact?.contact_schools ?? [];
  const location = contact?.locations
    ? [contact.locations.city, contact.locations.state].filter(Boolean).join(", ") || contact.locations.country
    : null;
  const stage: OutreachStage | null = markedContacted ? "contacted" : person.stage;

  const handleMarkContacted = async () => {
    try {
      await setStageOverride(person.contact_id, "contacted");
      setMarkedContacted(true);
      onChanged?.();
    } catch {
      /* non-blocking */
    }
  };

  return (
    <Modal isOpen onClose={onClose} size="lg">
      <div className="space-y-5">
        {/* Header */}
        <div className="flex items-start gap-4">
          <ContactAvatar name={person.name} photoUrl={person.photo_url} className="w-14 h-14 text-lg" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-semibold text-on-surface">{person.name}</h2>
              {contact?.linkedin_url && (
                <a href={contact.linkedin_url} target="_blank" rel="noopener noreferrer" className="text-on-surface-variant hover:text-primary" title="Open LinkedIn profile">
                  <ExternalLink className="w-4 h-4" />
                </a>
              )}
            </div>
            {person.headline && <p className="text-sm text-on-surface-variant mt-0.5">{person.headline}</p>}
            <div className="flex items-center gap-2 flex-wrap mt-2">
              {person.persona && (
                <span className="px-2 py-0.5 rounded-full text-[11px] bg-surface-container-high text-on-surface-variant">
                  {PERSONA_LABELS[person.persona] ?? person.persona}
                </span>
              )}
              {person.is_alum && (
                <span className="px-2 py-0.5 rounded-full text-[11px] bg-primary-container text-on-primary-container flex items-center gap-1">
                  <GraduationCap className="w-3 h-3" /> BYU
                </span>
              )}
              {stage && (
                <span className="px-2 py-0.5 rounded-full text-[11px] bg-surface-container-high text-on-surface-variant">
                  {STAGE_LABELS[stage]}
                </span>
              )}
              {location && (
                <span className="text-[11px] text-on-surface-variant flex items-center gap-1">
                  <MapPin className="w-3 h-3" /> {location}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Why they were kept */}
        {(person.review_note || person.selection_reason) && (
          <div className="rounded-xl bg-surface-container p-4 space-y-1.5">
            <p className="text-[11px] uppercase tracking-wide text-on-surface-variant font-medium">Why they&apos;re here</p>
            {person.review_note && <p className="text-sm text-on-surface">{person.review_note}</p>}
            {person.selection_reason && <p className="text-xs text-on-surface-variant italic">{person.selection_reason}</p>}
          </div>
        )}

        {/* Roles at this company */}
        <div>
          <p className="text-[11px] uppercase tracking-wide text-on-surface-variant font-medium mb-1.5">At {companyName}</p>
          <div className="space-y-1">
            {rolesHere.map((r) => (
              <p key={r.id} className="text-sm text-on-surface flex items-center gap-1.5">
                <Briefcase className="w-3.5 h-3.5 text-on-surface-variant shrink-0" />
                <span className="truncate">
                  {r.title ?? "—"}
                  <span className="text-on-surface-variant">
                    {" "}· {r.start_month ?? "?"} – {r.end_month ?? "?"}
                    {r.location_label && ` · ${r.location_label}`}
                    {r.workplace_type === "remote" && " · Remote"}
                  </span>
                </span>
              </p>
            ))}
          </div>
        </div>

        {/* Elsewhere */}
        {otherRoles.length > 0 && (
          <div>
            <p className="text-[11px] uppercase tracking-wide text-on-surface-variant font-medium mb-1.5">Elsewhere</p>
            <div className="space-y-1">
              {otherRoles.map((cc) => (
                <p key={cc.id} className="text-sm text-on-surface-variant truncate">
                  {cc.title ?? "—"} at <span className="text-on-surface">{cc.companies?.name}</span>
                  {cc.is_current ? " (current)" : cc.end_month ? ` (until ${cc.end_month})` : ""}
                </p>
              ))}
            </div>
          </div>
        )}

        {/* Education */}
        {education.length > 0 && (
          <div>
            <p className="text-[11px] uppercase tracking-wide text-on-surface-variant font-medium mb-1.5">Education</p>
            <div className="space-y-1">
              {education.map((cs) => (
                <p key={cs.id} className="text-sm text-on-surface-variant truncate">
                  <span className="text-on-surface">{cs.schools?.name}</span>
                  {cs.degree && ` · ${cs.degree}`}
                  {cs.field_of_study && `, ${cs.field_of_study}`}
                  {cs.end_year && ` · ${cs.end_year}`}
                </p>
              ))}
            </div>
          </div>
        )}

        {/* Email */}
        {person.email ? (
          <div className="flex items-center gap-2 text-sm">
            <Mail className="w-4 h-4 text-on-surface-variant" />
            <span className="text-on-surface">{person.email.address}</span>
            {person.email.bounced ? (
              <span className="text-[11px] text-error font-medium">bounced</span>
            ) : person.email.source === "pattern_guessed" ? (
              <span className="text-[11px] text-yellow-700 dark:text-yellow-400 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> pattern-guessed
              </span>
            ) : (
              <span className="text-[11px] text-on-surface-variant">{person.email.source}</span>
            )}
          </div>
        ) : (
          <p className="text-sm text-on-surface-variant flex items-center gap-2">
            <Mail className="w-4 h-4" /> No email on file — reach out on LinkedIn.
          </p>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 pt-1 border-t border-outline-variant/50 -mx-1 px-1 pt-4">
          {person.email && !person.email.bounced && (
            <Button onClick={() => onWriteEmail(person)}>
              <Mail className="w-4 h-4 mr-1.5" /> Write email
            </Button>
          )}
          <Link href={`/contacts/${person.contact_id}`}>
            <Button variant="tonal">Open full profile</Button>
          </Link>
          <button
            onClick={handleMarkContacted}
            disabled={markedContacted || stage !== "not_contacted"}
            className="ml-auto text-xs text-on-surface-variant hover:text-on-surface disabled:opacity-50 flex items-center gap-1"
            title="Record outreach that happened off-platform (e.g. LinkedIn DM)"
          >
            {markedContacted ? <><Check className="w-3.5 h-3.5" /> Marked contacted</> : "Mark contacted"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
