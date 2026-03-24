"use client";

import Link from "next/link";
import { ContactAvatar } from "@/components/contacts/contact-avatar";

interface NeglectedContact {
  id: number;
  name: string;
  photo_url: string | null;
  days_since_touch: number | null;
  follow_up_frequency_days: number | null;
}

interface NeglectedContactsProps {
  contacts: NeglectedContact[];
}

export function NeglectedContacts({ contacts }: NeglectedContactsProps) {
  if (contacts.length === 0) {
    return (
      <div className="rounded-xl bg-surface-container-low p-4 text-center">
        <p className="text-lg text-green-600 font-medium">All caught up</p>
        <p className="text-base text-muted-foreground mt-0.5">
          No relationships need urgent attention
        </p>
      </div>
    );
  }

  return (
    <div>
      <p className="text-lg font-medium text-foreground mb-3">
        Needs Attention
      </p>
      <div className="space-y-2.5">
        {contacts.slice(0, 3).map((c) => (
          <Link
            key={c.id}
            href={`/contacts/${c.id}`}
            className="flex items-center gap-3.5 rounded-lg px-4 py-2.5 hover:bg-surface-container-low transition-colors"
          >
            <ContactAvatar
              name={c.name}
              photoUrl={c.photo_url}
              className="w-11 h-11 text-sm shrink-0"
            />
            <div className="min-w-0 flex-1">
              <p className="text-base text-foreground truncate">{c.name}</p>
              <p className="text-sm text-muted-foreground">
                {c.days_since_touch === null
                  ? "Never contacted"
                  : `${c.days_since_touch}d since contact`}
              </p>
            </div>
          </Link>
        ))}
        {contacts.length > 3 && (
          <p className="text-sm text-muted-foreground px-4">
            +{contacts.length - 3} more past cadence
          </p>
        )}
      </div>
    </div>
  );
}
