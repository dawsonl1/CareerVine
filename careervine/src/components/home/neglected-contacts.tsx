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
        <p className="text-sm text-green-600 font-medium">All caught up</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          No relationships need urgent attention
        </p>
      </div>
    );
  }

  return (
    <div>
      <p className="text-sm font-medium text-foreground mb-2">
        Needs Attention
      </p>
      <div className="space-y-1.5">
        {contacts.slice(0, 3).map((c) => (
          <Link
            key={c.id}
            href={`/contacts/${c.id}`}
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-container-low transition-colors"
          >
            <ContactAvatar
              name={c.name}
              photoUrl={c.photo_url}
              className="w-7 h-7 text-[10px] shrink-0"
            />
            <div className="min-w-0 flex-1">
              <p className="text-xs text-foreground truncate">{c.name}</p>
              <p className="text-[10px] text-muted-foreground">
                {c.days_since_touch === null
                  ? "Never contacted"
                  : `${c.days_since_touch}d since contact`}
              </p>
            </div>
          </Link>
        ))}
        {contacts.length > 3 && (
          <p className="text-[10px] text-muted-foreground px-2">
            +{contacts.length - 3} more past cadence
          </p>
        )}
      </div>
    </div>
  );
}
