"use client";

import { useState } from "react";
import Link from "next/link";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { ChevronLeft, ChevronRight } from "lucide-react";

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

const PAGE_SIZE = 20; // 5x4 grid

function getAttentionReason(c: NeglectedContact): { label: string; borderClass: string } {
  if (c.days_since_touch === null) {
    return { label: "Never contacted", borderClass: "ring-[#9e9e9e]" };
  }
  return {
    label: `${c.days_since_touch}d since contact`,
    borderClass: "ring-[#e05555]",
  };
}

export function NeglectedContacts({ contacts }: NeglectedContactsProps) {
  const [page, setPage] = useState(0);

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

  const totalPages = Math.ceil(contacts.length / PAGE_SIZE);
  const pageContacts = contacts.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-lg font-medium text-foreground">
          Needs Attention
          <span className="text-base text-muted-foreground font-normal ml-2">
            {contacts.length}
          </span>
        </p>
        {totalPages > 1 && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="p-1 rounded-md hover:bg-surface-container-highest disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="h-4 w-4 text-muted-foreground" />
            </button>
            <span className="text-sm text-muted-foreground tabular-nums min-w-[3ch] text-center">
              {page + 1}/{totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page === totalPages - 1}
              className="p-1 rounded-md hover:bg-surface-container-highest disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 mb-3">
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full ring-[2.5px] ring-[#e05555] bg-transparent" />
          <span className="text-sm text-muted-foreground">Overdue</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full ring-[2.5px] ring-[#9e9e9e] bg-transparent" />
          <span className="text-sm text-muted-foreground">Never contacted</span>
        </div>
      </div>

      {/* Photo grid */}
      <div className="grid grid-cols-5 gap-3">
        {pageContacts.map((c) => {
          const { label, borderClass } = getAttentionReason(c);
          return (
            <Link
              key={c.id}
              href={`/contacts/${c.id}`}
              className="group relative flex flex-col items-center"
            >
              <ContactAvatar
                name={c.name}
                photoUrl={c.photo_url}
                className="w-14 h-14 text-lg group-hover:scale-110 transition-transform"
                ringClassName={borderClass}
              />
              {/* Tooltip on hover */}
              <div className="absolute -bottom-1 translate-y-full opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10 bg-surface-container-highest text-foreground text-sm rounded-lg px-3 py-1.5 shadow-lg whitespace-nowrap text-center">
                <p className="font-medium">{c.name}</p>
                <p className="text-xs text-muted-foreground">{label}</p>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
