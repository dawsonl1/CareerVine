/**
 * Two-level location filter for the Companies page (CAR-251).
 *
 * `MultiSelect`'s sibling for a facet whose values form a tree. It exists
 * because a flat list does not work here: the reference account has 409
 * distinct office cities, so the control needs both grouping (pick all of Utah
 * in one click) and search (reach "Natick" without scrolling past 400 rows).
 *
 * Everything structural is shared with `MultiSelect` — the same
 * `useListboxPopover` for keyboard, portal and positioning, the same
 * commit-and-stay-open behavior, the same "any" row that clears. Three things
 * differ:
 *
 * 1. **Rows are a flattened tree.** State headers and their cities live in one
 *    array so the index the popover hook navigates is still the index of a
 *    rendered child, which is what its `scrollIntoView` relies on.
 * 2. **Typing filters instead of jumping.** Focus deliberately stays on the
 *    trigger (the list preventDefaults its mousedown), so a real <input> inside
 *    the popover would either steal focus and close it or need the whole focus
 *    model rewritten. Printable keys build a query; Backspace edits it.
 * 3. **Selecting a state stores the STATE, not its cities.** Expanding on click
 *    would freeze the selection against today's data, so a Utah office added
 *    later would silently not match a "Utah" filter. The one exception is
 *    unchecking a single city from a selected state, which is an explicit
 *    narrowing and expands to the remaining cities.
 */

"use client";

import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check, Search } from "lucide-react";
import { useListboxPopover } from "@/components/ui/listbox-popover";
import { NO_LOCATION, type LocationGroupOption } from "@/lib/company-location-filter";

interface LocationMultiSelectProps {
  values: string[];
  onChange: (values: string[]) => void;
  groups: LocationGroupOption[];
  /** Companies with no office at all; the `none` row is hidden when zero. */
  noLocationCount: number;
  className?: string;
  triggerClassName?: string;
}

type Row =
  | { kind: "any"; key: string }
  | { kind: "none"; key: string; count: number }
  | { kind: "group"; key: string; value: string; label: string; count: number }
  | { kind: "city"; key: string; value: string; label: string; count: number; group: string };

const fold = (s: string) => s.toLowerCase().trim();

export function LocationMultiSelect({
  values,
  onChange,
  groups,
  noLocationCount,
  className,
  triggerClassName,
}: LocationMultiSelectProps) {
  const [query, setQuery] = useState("");
  const selected = useMemo(() => new Set(values), [values]);

  /**
   * Matching a STATE name keeps all its cities, so searching "utah" offers the
   * whole group; matching a CITY keeps only that city, with its header retained
   * for context. Without the header a bare "Natick" row gives no clue which
   * state it belongs to, which matters for the many duplicated US city names.
   */
  const visible = useMemo(() => {
    const q = fold(query);
    if (!q) return groups;
    return groups
      .map((g) => {
        if (fold(g.label).includes(q)) return g;
        const cities = g.cities.filter((c) => fold(c.label).includes(q));
        return cities.length > 0 ? { ...g, cities } : null;
      })
      .filter((g): g is LocationGroupOption => g !== null);
  }, [groups, query]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [{ kind: "any", key: "any" }];
    if (noLocationCount > 0 && (!query || fold("no location set").includes(fold(query)))) {
      out.push({ kind: "none", key: NO_LOCATION, count: noLocationCount });
    }
    for (const g of visible) {
      out.push({ kind: "group", key: g.value, value: g.value, label: g.label, count: g.count });
      for (const c of g.cities) {
        out.push({ kind: "city", key: c.value, value: c.value, label: c.label, count: c.count, group: g.value });
      }
    }
    return out;
  }, [visible, noLocationCount, query]);

  /** Emit in option order so the trigger label and the URL never reshuffle. */
  const emit = useCallback(
    (next: Set<string>) => {
      const ordered: string[] = [];
      if (next.has(NO_LOCATION)) ordered.push(NO_LOCATION);
      for (const g of groups) {
        if (next.has(g.value)) ordered.push(g.value);
        for (const c of g.cities) if (next.has(c.value)) ordered.push(c.value);
      }
      onChange(ordered);
    },
    [groups, onChange],
  );

  const onCommit = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row) return;
      if (row.kind === "any") {
        onChange([]);
        return;
      }
      const next = new Set(values);
      if (row.kind === "none") {
        if (next.has(NO_LOCATION)) next.delete(NO_LOCATION);
        else next.add(NO_LOCATION);
        emit(next);
        return;
      }
      if (row.kind === "group") {
        if (next.has(row.value)) next.delete(row.value);
        else {
          next.add(row.value);
          // Explicit city picks under a now-selected state are redundant, and
          // leaving them would make unchecking the state look like it did
          // nothing.
          const group = groups.find((g) => g.value === row.value);
          for (const c of group?.cities ?? []) next.delete(c.value);
        }
        emit(next);
        return;
      }
      // City row. Unchecking a city inside a selected state is a narrowing, so
      // the state expands into its remaining cities rather than being ignored.
      const group = groups.find((g) => g.value === row.group);
      if (next.has(row.group)) {
        next.delete(row.group);
        for (const c of group?.cities ?? []) if (c.value !== row.value) next.add(c.value);
      } else if (next.has(row.value)) {
        next.delete(row.value);
      } else {
        next.add(row.value);
        // Picking every city one by one collapses back to the state, so the
        // label reads "Utah" rather than "Lehi +6".
        const all = group?.cities ?? [];
        if (all.length > 1 && all.every((c) => next.has(c.value))) {
          for (const c of all) next.delete(c.value);
          next.add(row.group);
        }
      }
      emit(next);
    },
    [rows, values, groups, onChange, emit],
  );

  const firstSelectedRow = rows.findIndex((r) => r.kind !== "any" && selected.has(r.key));
  const selectedIndex = values.length === 0 ? 0 : Math.max(firstSelectedRow, 0);

  const {
    open, activeIndex, setActiveIndex, pos, btnRef, dropRef, listboxId, optionId,
    portalContainer, toggleOpen, close, commit, handleKeyDown,
  } = useListboxPopover({
    optionCount: rows.length,
    selectedIndex,
    onCommit,
    closeOnCommit: false,
  });

  /** Printable keys build the query; everything else is the shared key model. */
  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (open && e.key === "Backspace") {
      e.preventDefault();
      setQuery((q) => q.slice(0, -1));
      setActiveIndex(0);
      return;
    }
    if (open && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      setQuery((q) => q + e.key);
      setActiveIndex(0);
      return;
    }
    handleKeyDown(e);
  };

  const labelFor = (value: string) => {
    if (value === NO_LOCATION) return "No location set";
    for (const g of groups) {
      if (g.value === value) return g.label;
      for (const c of g.cities) if (c.value === value) return c.label;
    }
    // A value from a shared link may not exist in the loaded data. Showing the
    // raw value beats reading "Any location" while the list is being narrowed.
    return value.replace(/^[cs]:/, "");
  };
  const triggerLabel =
    values.length === 0
      ? "Any location"
      : values.length === 1
        ? labelFor(values[0])
        : `${labelFor(values[0])} +${values.length - 1}`;

  const isOn = (row: Row) => {
    if (row.kind === "any") return values.length === 0;
    if (row.kind === "city") return selected.has(row.value) || selected.has(row.group);
    return selected.has(row.key);
  };

  return (
    <div className={className || ""}>
      <button
        ref={btnRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-label="Filter by location"
        onClick={() => {
          setQuery("");
          toggleOpen();
        }}
        onKeyDown={onTriggerKeyDown}
        onBlur={close}
        className={`w-full h-14 px-4 bg-white text-left text-foreground rounded-[4px] border border-outline cursor-pointer focus:outline-none focus-visible:border-primary focus-visible:border-2 transition-colors text-sm flex items-center justify-between gap-2 ${triggerClassName ?? ""}`}
      >
        <span className={`truncate ${values.length > 0 ? "font-medium" : ""}`}>{triggerLabel}</span>
        <ChevronDown className={`h-4 w-4 text-muted-foreground shrink-0 transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
      </button>

      {open && createPortal(
        <div
          ref={dropRef}
          id={listboxId}
          role="listbox"
          aria-multiselectable="true"
          aria-label="Filter by location"
          onMouseDown={(e) => e.preventDefault()}
          style={{ position: "fixed", top: pos.top, left: pos.left, minWidth: pos.width }}
          className="z-[100] w-max max-w-[min(22rem,calc(100vw-2rem))] bg-white rounded-[12px] border border-outline-variant shadow-lg max-h-80 overflow-y-auto py-1"
        >
          {/* Not an <input>: focus stays on the trigger so the popover's blur
              model keeps working. Rendered as a listbox sibling and hidden from
              assistive tech, which reads the option rows themselves. */}
          <div
            aria-hidden
            className="sticky top-0 z-10 bg-white px-4 py-2 flex items-center gap-2 border-b border-outline-variant/60 text-sm"
          >
            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className={query ? "text-foreground" : "text-muted-foreground"}>
              {query || "Type to search"}
            </span>
          </div>

          {rows.length === 1 && (
            <div className="px-4 py-3 text-sm text-muted-foreground">No location matches “{query}”</div>
          )}

          {rows.map((row, index) => {
            const on = isOn(row);
            const isCity = row.kind === "city";
            const isAnyRow = row.kind === "any";
            // A city inside a selected state is on but not individually
            // removable in one click, so it reads as inherited rather than
            // looking like an ordinary pick the user made.
            const inherited = isCity && !selected.has(row.value) && selected.has(row.group);
            return (
              <div
                key={row.key}
                id={optionId(index)}
                role="option"
                aria-selected={on}
                onClick={() => commit(index)}
                onMouseEnter={() => setActiveIndex(index)}
                className={`w-full text-left py-2.5 text-sm flex items-center gap-3 cursor-pointer transition-all duration-100 ${
                  isCity ? "pl-11 pr-4" : "px-4"
                } ${on ? "text-primary font-medium" : "text-foreground"} ${
                  row.kind === "group" ? "font-medium" : ""
                } ${index === activeIndex ? "bg-surface-container" : ""} ${
                  isAnyRow ? "border-b border-outline-variant/60 mb-1" : ""
                }`}
              >
                <span
                  aria-hidden
                  className={`shrink-0 w-[18px] h-[18px] rounded-[4px] border-2 flex items-center justify-center transition-colors duration-100 ${
                    on ? (inherited ? "bg-primary/40 border-primary/40" : "bg-primary border-primary") : "bg-transparent border-outline"
                  }`}
                >
                  {on && <Check className="h-3 w-3 text-on-primary" strokeWidth={3} />}
                </span>
                <span className="truncate flex-1">
                  {row.kind === "any" ? "Any location" : row.kind === "none" ? "No location set" : row.label}
                </span>
                {row.kind !== "any" && (
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{row.count}</span>
                )}
              </div>
            );
          })}
        </div>,
        portalContainer ?? document.body,
      )}
    </div>
  );
}
