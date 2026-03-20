"use client";

import type { Contact } from "@/lib/types";
import { User, Users, StickyNote } from "lucide-react";

interface ContactAboutCardProps {
  contact: Contact;
}

export function ContactAboutCard({ contact }: ContactAboutCardProps) {
  const hasBio = contact.notes;
  const hasMetThrough = contact.met_through;
  const hasTags = contact.contact_tags.length > 0;

  if (!hasBio && !hasMetThrough && !hasTags) return null;

  return (
    <div className="rounded-[16px] border border-outline-variant p-5 space-y-3">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        About
      </h3>

      {/* Bio / Notes */}
      {hasBio && (
        <div className="flex gap-2">
          <StickyNote className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
          <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
            {contact.notes}
          </p>
        </div>
      )}

      {/* Met through */}
      {hasMetThrough && (
        <div className="flex items-center gap-2 text-sm">
          <Users className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground">Met through</span>
          <span className="text-foreground">{contact.met_through}</span>
        </div>
      )}

      {/* Tags */}
      {hasTags && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {contact.contact_tags.map((ct) => (
            <span
              key={ct.tag_id}
              className="inline-flex items-center h-6 px-2.5 rounded-full bg-secondary-container text-[11px] text-on-secondary-container font-medium"
            >
              {ct.tags.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
