import { useCallback, useMemo, useState } from "react";
import type { EmailMessage, EmailFollowUp } from "@/lib/types";
import { isWithinDays, type EmailThread } from "@/lib/gmail-helpers";

export type FilterDirection = "all" | "inbound" | "outbound";
export type FilterThreadType = "all" | "threads" | "single";
export type FilterFollowUp = "all" | "with" | "without";

interface UseInboxFiltersParams {
  inboxThreads: EmailThread[];
  sentThreads: EmailThread[];
  trashThreads: EmailThread[];
  hiddenThreads: EmailThread[];
  emails: EmailMessage[];
  contactMap: Record<number, string>;
  followUpsByThread: Record<string, EmailFollowUp[]>;
}

/**
 * Owns the inbox's search + advanced-filter state and derives the filtered
 * thread lists for each mailbox view (CAR-150). Extracted from InboxShell so the
 * shell stays a thin coordinator; the top bar and filter bar read/drive this
 * state, and the tab views consume the filtered lists.
 */
export function useInboxFilters({
  inboxThreads,
  sentThreads,
  trashThreads,
  hiddenThreads,
  emails,
  contactMap,
  followUpsByThread,
}: UseInboxFiltersParams) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedContactId, setSelectedContactId] = useState<number | null>(null);
  const [contactSearchQuery, setContactSearchQuery] = useState("");
  const [filterDirection, setFilterDirection] = useState<FilterDirection>("all");
  const [filterDays, setFilterDays] = useState<number | null>(null);
  const [filterThreadType, setFilterThreadType] = useState<FilterThreadType>("all");
  const [filterFollowUp, setFilterFollowUp] = useState<FilterFollowUp>("all");
  const [showFilters, setShowFilters] = useState(false);

  // Contact list for the filter (search-based). Built from every attributed
  // contact (all junction links, CAR-169), so a contact who only ever appears
  // as a co-recipient on a shared thread is still offered as a filter option.
  const contactsInEmails = useMemo(() => {
    const ids = new Set<number>();
    for (const e of emails) {
      const linked = e.contact_ids ?? (e.matched_contact_id != null ? [e.matched_contact_id] : []);
      for (const id of linked) ids.add(id);
    }
    return Array.from(ids)
      .map((id) => ({ id, name: contactMap[id] || `Contact #${id}` }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [emails, contactMap]);

  const filteredContactOptions = useMemo(() => {
    if (!contactSearchQuery.trim()) return contactsInEmails;
    const q = contactSearchQuery.toLowerCase();
    return contactsInEmails.filter((c) => c.name.toLowerCase().includes(q));
  }, [contactsInEmails, contactSearchQuery]);

  const filterThreads = useCallback(
    (threads: EmailThread[]) => {
      let filtered = threads;

      // Contact filter: a shared thread matches under EVERY contact it involves
      // (CAR-169), not just the denormalized primary.
      if (selectedContactId !== null) {
        filtered = filtered.filter((t) => t.contactIds.includes(selectedContactId));
      }

      // Direction filter
      if (filterDirection !== "all") {
        filtered = filtered.filter((t) =>
          t.messages.some((m) => m.direction === filterDirection)
        );
      }

      // Recent activity (days) filter
      if (filterDays !== null) {
        filtered = filtered.filter((t) => isWithinDays(t.latestDate, filterDays));
      }

      // Thread type filter
      if (filterThreadType === "threads") {
        filtered = filtered.filter((t) => t.messages.length > 1);
      } else if (filterThreadType === "single") {
        filtered = filtered.filter((t) => t.messages.length === 1);
      }

      // Follow-up filter
      if (filterFollowUp === "with") {
        filtered = filtered.filter((t) => {
          const fus = followUpsByThread[t.threadId];
          return fus && fus.length > 0;
        });
      } else if (filterFollowUp === "without") {
        filtered = filtered.filter((t) => {
          const fus = followUpsByThread[t.threadId];
          return !fus || fus.length === 0;
        });
      }

      // Text search
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        filtered = filtered.filter(
          (t) =>
            t.subject.toLowerCase().includes(q) ||
            t.messages.some(
              (m) =>
                m.snippet?.toLowerCase().includes(q) ||
                m.from_address?.toLowerCase().includes(q) ||
                m.to_addresses?.some((a) => a.toLowerCase().includes(q))
            ) ||
            t.contactIds.some((id) => contactMap[id]?.toLowerCase().includes(q))
        );
      }

      return filtered;
    },
    [searchQuery, selectedContactId, contactMap, filterDirection, filterDays, filterThreadType, filterFollowUp, followUpsByThread]
  );

  const filteredInboxThreads = useMemo(() => filterThreads(inboxThreads), [filterThreads, inboxThreads]);
  const filteredSentThreads = useMemo(() => filterThreads(sentThreads), [filterThreads, sentThreads]);
  const filteredTrashThreads = useMemo(() => filterThreads(trashThreads), [filterThreads, trashThreads]);
  const filteredHiddenThreads = useMemo(() => filterThreads(hiddenThreads), [filterThreads, hiddenThreads]);

  const activeFilterCount = [
    filterDirection !== "all",
    filterDays !== null,
    filterThreadType !== "all",
    filterFollowUp !== "all",
    selectedContactId !== null,
  ].filter(Boolean).length;

  const clearAllFilters = () => {
    setFilterDirection("all");
    setFilterDays(null);
    setFilterThreadType("all");
    setFilterFollowUp("all");
    setSelectedContactId(null);
    setContactSearchQuery("");
  };

  return {
    // State + setters
    searchQuery, setSearchQuery,
    selectedContactId, setSelectedContactId,
    contactSearchQuery, setContactSearchQuery,
    filterDirection, setFilterDirection,
    filterDays, setFilterDays,
    filterThreadType, setFilterThreadType,
    filterFollowUp, setFilterFollowUp,
    showFilters, setShowFilters,
    // Derived
    filteredContactOptions,
    filteredInboxThreads,
    filteredSentThreads,
    filteredTrashThreads,
    filteredHiddenThreads,
    activeFilterCount,
    clearAllFilters,
  };
}
