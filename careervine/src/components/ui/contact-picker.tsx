/**
 * ContactPicker — searchable multi-select for contacts
 *
 * Renders selected contacts as removable chips and provides a
 * search input to filter and add contacts from the full list.
 *
 * Props:
 *   - allContacts: full list of { id, name } to search through
 *   - selectedIds: currently selected contact IDs
 *   - onChange: callback with updated ID array
 *
 * Used in: action item forms, meeting attendee selection
 */

"use client";

import { useState, useRef, useCallback } from "react";
import { X, Search } from "lucide-react";
import { useClickOutside } from "@/hooks/use-click-outside";

interface ContactPickerProps {
  allContacts: { id: number; name: string }[];
  selectedIds: number[];
  onChange: (ids: number[]) => void;
  placeholder?: string;
}

export function ContactPicker({
  allContacts,
  selectedIds,
  onChange,
  placeholder = "Search contacts…",
}: ContactPickerProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useClickOutside(ref, useCallback(() => setOpen(false), []));

  const selected = allContacts.filter((c) => selectedIds.includes(c.id));
  const filtered = allContacts
    .filter((c) => !selectedIds.includes(c.id))
    .filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 8);

  const addContact = (id: number) => {
    onChange([...selectedIds, id]);
    setQuery("");
    inputRef.current?.focus();
  };

  const removeContact = (id: number) => {
    onChange(selectedIds.filter((cid) => cid !== id));
  };

  return (
    <div ref={ref} className="relative">
      <div
        className="min-h-[3.5rem] px-3 py-2 bg-surface-container-low text-foreground rounded-[4px] border border-outline focus-within:border-primary focus-within:border-2 transition-colors flex flex-wrap items-center gap-1.5 cursor-text"
        onClick={() => inputRef.current?.focus()}
      >
        {selected.map((c) => (
          <span
            key={c.id}
            className="inline-flex items-center gap-1 h-7 pl-2.5 pr-1.5 rounded-full text-xs font-medium bg-secondary-container text-on-secondary-container"
          >
            {c.name}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); removeContact(c.id); }}
              className="p-0.5 rounded-full hover:bg-on-secondary-container/10 cursor-pointer transition-colors"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <div className="flex-1 min-w-[120px] flex items-center gap-1.5">
          <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground"
            placeholder={selected.length > 0 ? "Add more…" : placeholder}
          />
        </div>
      </div>
      {open && filtered.length > 0 && (
        <div className="absolute z-50 mt-1 left-0 w-full bg-surface-container-high rounded-[12px] shadow-lg border border-outline-variant overflow-hidden animate-in fade-in-0 zoom-in-95 max-h-[200px] overflow-y-auto">
          {filtered.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => addContact(c.id)}
              className="w-full text-left px-4 py-2.5 text-sm text-foreground hover:bg-surface-container cursor-pointer transition-colors"
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
      {open && query.trim().length > 0 && filtered.length === 0 && (
        <div className="absolute z-50 mt-1 left-0 w-full bg-surface-container-high rounded-[12px] shadow-lg border border-outline-variant overflow-hidden p-4">
          <p className="text-sm text-muted-foreground text-center">No contacts found</p>
        </div>
      )}
    </div>
  );
}
