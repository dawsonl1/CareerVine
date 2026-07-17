import { X } from "lucide-react";
import type { FilterDirection, FilterThreadType, FilterFollowUp } from "./use-inbox-filters";

interface InboxFilterBarProps {
  filterDirection: FilterDirection;
  setFilterDirection: (value: FilterDirection) => void;
  filterDays: number | null;
  setFilterDays: (value: number | null) => void;
  filterThreadType: FilterThreadType;
  setFilterThreadType: (value: FilterThreadType) => void;
  filterFollowUp: FilterFollowUp;
  setFilterFollowUp: (value: FilterFollowUp) => void;
  selectedContactId: number | null;
  setSelectedContactId: (value: number | null) => void;
  contactSearchQuery: string;
  setContactSearchQuery: (value: string) => void;
  contactMap: Record<number, string>;
  filteredContactOptions: { id: number; name: string }[];
  activeFilterCount: number;
  clearAllFilters: () => void;
}

/** The expandable advanced-filter row (direction, activity window, type, follow-ups, contact). */
export function InboxFilterBar({
  filterDirection,
  setFilterDirection,
  filterDays,
  setFilterDays,
  filterThreadType,
  setFilterThreadType,
  filterFollowUp,
  setFilterFollowUp,
  selectedContactId,
  setSelectedContactId,
  contactSearchQuery,
  setContactSearchQuery,
  contactMap,
  filteredContactOptions,
  activeFilterCount,
  clearAllFilters,
}: InboxFilterBarProps) {
  return (
    <div className="mb-5 p-4 bg-surface-container-low rounded-xl border border-outline-variant/50">
      <div className="flex flex-wrap items-center gap-4">
        {/* Direction */}
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-muted-foreground">Direction:</span>
          <div className="flex rounded-lg border border-outline-variant overflow-hidden">
            {(["all", "inbound", "outbound"] as const).map((dir) => (
              <button
                key={dir}
                type="button"
                onClick={() => setFilterDirection(dir)}
                className={`px-3 py-1.5 text-sm font-medium transition-colors cursor-pointer ${
                  filterDirection === dir ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-surface-container-low"
                }`}
              >
                {dir === "all" ? "All" : dir === "inbound" ? "Incoming" : "Outgoing"}
              </button>
            ))}
          </div>
        </div>

        {/* Days */}
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-muted-foreground">Activity:</span>
          <div className="flex rounded-lg border border-outline-variant overflow-hidden">
            {([null, 7, 14, 30, 90] as const).map((d) => (
              <button
                key={d ?? "all"}
                type="button"
                onClick={() => setFilterDays(d)}
                className={`px-3 py-1.5 text-sm font-medium transition-colors cursor-pointer ${
                  filterDays === d ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-surface-container-low"
                }`}
              >
                {d === null ? "All" : `${d}d`}
              </button>
            ))}
          </div>
        </div>

        {/* Thread type */}
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-muted-foreground">Type:</span>
          <div className="flex rounded-lg border border-outline-variant overflow-hidden">
            {(["all", "threads", "single"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setFilterThreadType(t)}
                className={`px-3 py-1.5 text-sm font-medium transition-colors cursor-pointer ${
                  filterThreadType === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-surface-container-low"
                }`}
              >
                {t === "all" ? "All" : t === "threads" ? "Threads" : "Single"}
              </button>
            ))}
          </div>
        </div>

        {/* Follow-ups */}
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-muted-foreground">Follow-ups:</span>
          <div className="flex rounded-lg border border-outline-variant overflow-hidden">
            {(["all", "with", "without"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilterFollowUp(f)}
                className={`px-3 py-1.5 text-sm font-medium transition-colors cursor-pointer ${
                  filterFollowUp === f ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-surface-container-low"
                }`}
              >
                {f === "all" ? "All" : f === "with" ? "With" : "Without"}
              </button>
            ))}
          </div>
        </div>

        {/* Contact search */}
        <div className="flex items-center gap-2 relative">
          <span className="text-sm font-medium text-muted-foreground">Contact:</span>
          {selectedContactId !== null ? (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary-container text-on-primary-container text-sm font-medium">
              <span className="max-w-36 truncate">{contactMap[selectedContactId]}</span>
              <button
                type="button"
                className="p-0.5 rounded-full hover:bg-primary/20 cursor-pointer"
                onClick={() => { setSelectedContactId(null); setContactSearchQuery(""); }}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <div className="relative">
              <input
                type="text"
                value={contactSearchQuery}
                onChange={(e) => setContactSearchQuery(e.target.value)}
                placeholder="Search by name..."
                className="w-44 h-8 px-3 text-sm bg-transparent border border-outline-variant rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary transition-colors"
              />
              {contactSearchQuery.trim() && filteredContactOptions.length > 0 && (
                <div className="absolute left-0 top-9 z-50 w-60 max-h-52 overflow-y-auto bg-surface-container-high rounded-xl shadow-lg border border-outline-variant py-1">
                  {filteredContactOptions.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="w-full text-left px-4 py-2.5 text-sm text-foreground hover:bg-surface-container-low cursor-pointer transition-colors"
                      onClick={() => { setSelectedContactId(c.id); setContactSearchQuery(""); }}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Clear all */}
        {activeFilterCount > 0 && (
          <button
            type="button"
            onClick={clearAllFilters}
            className="ml-auto text-sm font-medium text-primary hover:text-primary/80 cursor-pointer transition-colors"
          >
            Clear all
          </button>
        )}
      </div>
    </div>
  );
}
