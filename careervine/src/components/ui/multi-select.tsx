/**
 * M3 multi-select dropdown (CAR-245).
 *
 * `Select`'s sibling for facet filters, where the answer is a SET: two tiers, or
 * both "Replied" and "Call done". Same trigger, same portal, same keyboard model —
 * all of it from `useListboxPopover`, which is where the reasoning for the popover
 * behavior lives. Three things differ from `Select`:
 *
 * 1. **Committing toggles and the list stays open.** Picking several values is the
 *    entire point; closing after each one would make the control worse than the
 *    single-select it replaced.
 * 2. **A leading "any" row clears the selection**, and reads as selected while the
 *    set is empty. It keeps parity with the `Any traction` row these dropdowns had
 *    as single-selects, and gives keyboard users a way back to "no filter" without
 *    unchecking rows one at a time.
 * 3. **The list is at least as wide as the trigger, and wider if the labels need
 *    it.** The trigger collapses to "Any traction" while its options are much
 *    longer, so `Select`'s exactly-trigger-width list would truncate them.
 *
 * Values are held in OPTION order, not click order, so the summary label ("Replied
 * +1") does not reshuffle as the user checks boxes.
 *
 * @example
 * <MultiSelect
 *   ariaLabel="Filter by traction"
 *   anyLabel="Any traction"
 *   values={filters.traction}
 *   onChange={(v) => setFilters({ ...filters, traction: v as OutreachStage[] })}
 *   options={STAGE_ORDER.map((s) => ({ value: s, label: STAGE_LABELS[s] }))}
 * />
 */

"use client";

import { useCallback } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check } from "lucide-react";
import { useListboxPopover } from "@/components/ui/listbox-popover";
import type { SelectOption } from "@/components/ui/select";

interface MultiSelectProps {
  /** Selected values. Empty means "any", which is the absence of a filter. */
  values: string[];
  onChange: (values: string[]) => void;
  options: SelectOption[];
  /** Trigger text while nothing is selected, and the label of the row that clears. */
  anyLabel: string;
  className?: string;
  /** Extra classes for the trigger button. Use `!` to win over defaults. */
  triggerClassName?: string;
  /**
   * Accessible name for the field. A visible `<label>` cannot be associated with a
   * button, and the trigger's own text is the value, so without this a screen
   * reader announces the value with no idea which field it belongs to (CAR-201).
   */
  ariaLabel?: string;
}

export function MultiSelect({
  values,
  onChange,
  options,
  anyLabel,
  className,
  triggerClassName,
  ariaLabel,
}: MultiSelectProps) {
  // Row 0 is the "any" row; option i is row i + 1. One flat array so the index the
  // popover hook navigates is the index of a rendered child, which is what
  // `scrollIntoView` on `dropRef.children` relies on.
  const rowCount = options.length + 1;
  const selected = new Set(values);

  const onCommit = useCallback((index: number) => {
    if (index === 0) {
      onChange([]);
      return;
    }
    const option = options[index - 1];
    if (!option) return;
    const next = new Set(values);
    if (next.has(option.value)) next.delete(option.value);
    else next.add(option.value);
    // Re-derived in option order rather than pushed onto the end, so the label and
    // the URL are stable regardless of the order rows were clicked.
    onChange(options.filter((o) => next.has(o.value)).map((o) => o.value));
  }, [options, values, onChange]);

  /** Opening lands on "any" when nothing is picked, else on the first pick. */
  const firstSelectedRow = options.findIndex((o) => selected.has(o.value)) + 1;
  const selectedIndex = values.length === 0 ? 0 : firstSelectedRow;

  const {
    open, activeIndex, setActiveIndex, pos, btnRef, dropRef, listboxId, optionId,
    portalContainer, toggleOpen, close, commit, handleKeyDown,
  } = useListboxPopover({
    optionCount: rowCount,
    selectedIndex,
    onCommit,
    closeOnCommit: false,
  });

  // A value with no matching option still shows its own text: a `tier` from a
  // shared URL may not exist in the loaded data, and reading "Any tier" while a
  // tier filter is silently narrowing the list is the one label that must not lie.
  const labelFor = (value: string) => options.find((o) => o.value === value)?.label ?? value;
  const ordered = options.filter((o) => selected.has(o.value)).map((o) => o.value);
  const shown = ordered.length > 0 ? ordered : values;
  const triggerLabel =
    values.length === 0
      ? anyLabel
      : values.length === 1
        ? labelFor(shown[0])
        : `${labelFor(shown[0])} +${values.length - 1}`;

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
        aria-label={ariaLabel}
        onClick={toggleOpen}
        onKeyDown={handleKeyDown}
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
          aria-label={ariaLabel}
          // Keeps the trigger from blurring on the way to a click, which would close
          // the list before the row's onClick ever ran.
          onMouseDown={(e) => e.preventDefault()}
          style={{ position: "fixed", top: pos.top, left: pos.left, minWidth: pos.width }}
          className="z-[100] w-max max-w-[min(20rem,calc(100vw-2rem))] bg-white rounded-[12px] border border-outline-variant shadow-lg max-h-64 overflow-y-auto py-1"
        >
          {[{ value: "", label: anyLabel }, ...options].map((row, index) => {
            const isAnyRow = index === 0;
            const on = isAnyRow ? values.length === 0 : selected.has(row.value);
            return (
              <div
                key={index}
                id={optionId(index)}
                role="option"
                aria-selected={on}
                onClick={() => commit(index)}
                onMouseEnter={() => setActiveIndex(index)}
                className={`w-full text-left px-4 py-2.5 text-sm flex items-center gap-3 cursor-pointer transition-all duration-100 ${
                  on ? "text-primary font-medium" : "text-foreground"
                } ${index === activeIndex ? "bg-surface-container" : ""} ${isAnyRow ? "border-b border-outline-variant/60 mb-1" : ""}`}
              >
                {/* Visual only: the row's own `aria-selected` is what assistive tech
                    reads, and a nested checkbox role inside an option is invalid. */}
                <span
                  aria-hidden
                  className={`shrink-0 w-[18px] h-[18px] rounded-[4px] border-2 flex items-center justify-center transition-colors duration-100 ${
                    on ? "bg-primary border-primary" : "bg-transparent border-outline"
                  }`}
                >
                  {on && <Check className="h-3 w-3 text-on-primary" strokeWidth={3} />}
                </span>
                <span className="truncate">{row.label}</span>
              </div>
            );
          })}
        </div>,
        portalContainer ?? document.body,
      )}
    </div>
  );
}
