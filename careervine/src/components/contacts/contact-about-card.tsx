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
    <div className="rounded-[16px] border border-outline-variant p-6 space-y-4">
      <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
        About
      </h3>

      {/* Bio / Notes */}
      {hasBio && (
        <div className="flex gap-2.5">
          <StickyNote className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
          <p className="text-base text-foreground whitespace-pre-wrap leading-relaxed">
            {contact.notes}
          </p>
        </div>
      )}

      {/* Met through */}
      {hasMetThrough && (
        <div className="flex items-center gap-2.5 text-base">
          <Users className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground">Met through</span>
          <span className="text-foreground">{contact.met_through}</span>
        </div>
      )}

      {/* Tags */}
      {hasTags && (
        <div className="flex flex-wrap gap-2 pt-1">
          {contact.contact_tags.map((ct) => (
            <span
              key={ct.tag_id}
              className="inline-flex items-center h-7 px-3 rounded-full bg-secondary-container text-xs text-on-secondary-container font-medium"
            >
              {ct.tags.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
