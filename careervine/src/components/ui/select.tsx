/**
 * M3 Select / Dropdown component
 *
 * A select-only combobox, following the WAI-ARIA APG pattern: the trigger is the
 * only focusable part, and it keeps DOM focus for the whole interaction while
 * `aria-activedescendant` names which option is active. Arrow keys move that
 * pointer, Enter/Space commit, Escape and Tab close.
 *
 * Portal target (CAR-198). The option list renders through a portal so it escapes
 * parent `overflow: hidden` containers, and inside a Modal it portals to that
 * dialog's own surface rather than to `document.body`. A list on the body sits
 * outside the modal's focus trap AND outside its `aria-modal` subtree, so it is
 * both keyboard-unreachable and invisible to a screen reader while looking
 * perfectly correct on screen. `useModalPortalContainer` in `modal.tsx` documents
 * why portalling into an `overflow: hidden` surface stays visually correct.
 *
 * Why focus stays on the trigger rather than moving into the options (CAR-198
 * review): options that hold real focus have to live somewhere in the tab order,
 * and a portal can only append, so they landed *after* every other control in the
 * dialog — a keyboard user tabbing out of the list arrived at the Close button
 * having skipped the whole form. Worse, nothing closed a list the user had tabbed
 * away from, and the stale list's Escape handler then swallowed Escape for every
 * layer above it, including the unsaved-changes dialog, leaving that dialog's
 * buttons unreachable. Keeping focus on the trigger removes the entire class:
 * there is no second focus location to strand, to order, or to leak Escape from.
 *
 * Escape is claimed on a document listener in the CAPTURE phase, and only while
 * this trigger actually holds focus. Capture beats the Modal's bubble-phase
 * document listener deterministically, so "Escape closes the list, not the
 * dialog" does not depend on which component mounted first; the focus check is
 * what stops it firing on behalf of a layer that has since opened above it.
 *
 * @example
 * <Select
 *   value={type}
 *   onChange={setType}
 *   options={[{ value: "coffee", label: "Coffee" }]}
 *   placeholder="Select type"
 * />
 */

"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check } from "lucide-react";
import { useModalPortalContainer } from "@/components/ui/modal";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  required?: boolean;
  className?: string;
  /** Extra classes for the trigger button (e.g. to override radius). Use `!` to win over defaults. */
  triggerClassName?: string;
  /**
   * Accessible name for the field. A visible `<label>` cannot be associated with a
   * button, and once a value is chosen the trigger's own text *is* the value, so
   * without this a screen reader announces the value with no idea which field it
   * belongs to.
   */
  ariaLabel?: string;
}

export function Select({ value, onChange, options, placeholder = "Select…", required, className, triggerClassName, ariaLabel }: SelectProps) {
  const [open, setOpen] = useState(false);
  /** Which option `aria-activedescendant` points at. -1 while nothing is active. */
  const [activeIndex, setActiveIndex] = useState(-1);
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number) => `${baseId}-option-${index}`;
  const portalContainer = useModalPortalContainer();

  const updatePos = useCallback(() => {
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    }
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  const openAt = useCallback((index: number) => {
    if (options.length === 0) return;
    updatePos();
    setActiveIndex(Math.min(Math.max(index, 0), options.length - 1));
    setOpen(true);
    // Guaranteed rather than assumed: Safari does not focus a button on click, and
    // every keyboard path below reads `document.activeElement === btnRef.current`.
    btnRef.current?.focus();
  }, [options.length, updatePos]);

  const commit = useCallback((index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    close();
    btnRef.current?.focus();
  }, [options, onChange, close]);

  /** Index of the committed value, or 0 so an opening keypress lands somewhere sane. */
  const selectedIndex = options.findIndex((o) => o.value === value);

  // Close on outside click, dismiss on Escape, reposition on scroll/resize.
  useEffect(() => {
    if (!open) return;
    updatePos();

    const handleOutside = (e: MouseEvent) => {
      if (
        btnRef.current && !btnRef.current.contains(e.target as Node) &&
        dropRef.current && !dropRef.current.contains(e.target as Node)
      ) {
        close();
      }
    };
    const handleEscapeCapture = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Only claim Escape while this trigger holds focus. Without the check a list
      // left open under a newer layer would swallow that layer's Escape.
      if (document.activeElement !== btnRef.current) return;
      e.stopPropagation();
      close();
    };

    document.addEventListener("mousedown", handleOutside);
    document.addEventListener("keydown", handleEscapeCapture, true);
    window.addEventListener("scroll", updatePos, true);
    window.addEventListener("resize", updatePos);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      document.removeEventListener("keydown", handleEscapeCapture, true);
      window.removeEventListener("scroll", updatePos, true);
      window.removeEventListener("resize", updatePos);
    };
  }, [open, updatePos, close]);

  // Keep the active option in view when arrow keys walk past the list's edges.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    dropRef.current?.children[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex]);

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const last = options.length - 1;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!open) openAt(selectedIndex >= 0 ? selectedIndex : 0);
        else setActiveIndex((i) => (i >= last ? 0 : i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        if (!open) openAt(selectedIndex >= 0 ? selectedIndex : last);
        else setActiveIndex((i) => (i <= 0 ? last : i - 1));
        break;
      case "Home":
        if (!open) return;
        e.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        if (!open) return;
        e.preventDefault();
        setActiveIndex(last);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (!open) openAt(selectedIndex >= 0 ? selectedIndex : 0);
        else commit(activeIndex);
        break;
      case "Tab":
        // Not prevented: the list closes and focus moves on, as a native select does.
        if (open) close();
        break;
    }
  };

  const selectedLabel = options.find((o) => o.value === value)?.label;

  return (
    <div className={className || ""}>
      {/* Hidden native select for form validation */}
      {required && (
        <select
          value={value}
          onChange={() => {}}
          required
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
        >
          <option value="">{placeholder}</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      )}

      <button
        ref={btnRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-label={ariaLabel}
        onClick={() => (open ? close() : openAt(selectedIndex >= 0 ? selectedIndex : 0))}
        onKeyDown={handleKeyDown}
        onBlur={close}
        className={`w-full h-14 px-4 bg-white text-left text-foreground rounded-[4px] border border-outline cursor-pointer focus:outline-none focus-visible:border-primary focus-visible:border-2 transition-colors text-sm flex items-center justify-between gap-2 ${triggerClassName ?? ""}`}
      >
        <span className={selectedLabel ? "text-foreground" : "text-muted-foreground"}>
          {selectedLabel || placeholder}
        </span>
        <ChevronDown className={`h-4 w-4 text-muted-foreground shrink-0 transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
      </button>

      {open && createPortal(
        <div
          ref={dropRef}
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          // Keeps the trigger from blurring on the way to a click, which would close
          // the list through onBlur before the option's onClick ever ran.
          onMouseDown={(e) => e.preventDefault()}
          style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width }}
          className="z-[100] bg-white rounded-[12px] border border-outline-variant shadow-lg max-h-64 overflow-y-auto py-1"
        >
          {options.map((option, index) => (
            <div
              // Index, not value: the pipeline's scope Select can list two options
              // with the same value, and duplicate keys make React reuse one node for
              // both — the same duplicate-value case `select.test.tsx` pins.
              key={index}
              id={optionId(index)}
              role="option"
              aria-selected={option.value === value}
              onClick={() => commit(index)}
              onMouseEnter={() => setActiveIndex(index)}
              className={`w-full text-left px-4 py-3 text-sm flex items-center justify-between gap-2 cursor-pointer transition-all duration-100 ${
                option.value === value
                  ? "bg-primary/8 text-primary font-medium"
                  : "text-foreground"
              } ${index === activeIndex ? "bg-surface-container" : ""}`}
            >
              <span>{option.label}</span>
              {option.value === value && <Check className="h-4 w-4 text-primary shrink-0" />}
            </div>
          ))}
        </div>,
        portalContainer ?? document.body,
      )}
    </div>
  );
}
