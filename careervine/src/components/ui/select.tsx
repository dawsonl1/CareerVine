/**
 * M3 Select / Dropdown component
 *
 * Custom dropdown whose menu renders through a React portal so it escapes parent
 * `overflow: hidden` containers. Inside a Modal it portals to that dialog's own
 * surface rather than to `document.body` (CAR-198): the modal's focus trap is
 * "everything inside the surface", so a menu on `document.body` sits outside it
 * and Tab can never reach the options. `useModalPortalContainer` in `modal.tsx`
 * documents why portalling into an `overflow: hidden` surface stays visually
 * correct, and what would break it.
 *
 * Keyboard:
 *   - ArrowDown / ArrowUp open the menu onto the first / last option, and move
 *     between options with wraparound once it is open
 *   - Home / End jump to the ends
 *   - Enter / Space commit the focused option
 *   - Escape closes the menu and returns focus to the trigger
 *
 * The options are ordinary tabbable buttons, not a roving-tabindex listbox. The
 * modal trap drops anything carrying a negative tabindex, so roving would quietly
 * re-open the hole this component was fixed for.
 *
 * Escape is handled on a document listener in the CAPTURE phase. That is what
 * makes "Escape closes the menu, not the dialog" deterministic rather than
 * incidental: Modal listens for Escape on `document` in the bubble phase, and
 * capture on the same node always runs first, so stopping propagation there
 * cannot be reordered by which component mounted when.
 *
 * Every close path that unmounts the focused option hands focus back to the
 * trigger. Skipping that drops focus to `<body>`, which is outside the trap.
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
}

export function Select({ value, onChange, options, placeholder = "Select…", required, className, triggerClassName }: SelectProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const portalContainer = useModalPortalContainer();

  /**
   * Option nodes keyed by value rather than by index, so an option leaving the
   * list removes its own entry on unmount and a lookup can never resolve to a
   * detached node.
   */
  const optionNodes = useRef(new Map<string, HTMLButtonElement>());
  /** Where to land once the menu has actually mounted, set by the opening keypress. */
  const pendingFocus = useRef<number | null>(null);

  const updatePos = useCallback(() => {
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    }
  }, []);

  const focusOption = useCallback((index: number) => {
    const count = options.length;
    if (count === 0) return;
    const wrapped = ((index % count) + count) % count;
    optionNodes.current.get(options[wrapped].value)?.focus();
  }, [options]);

  const closeAndRefocus = useCallback(() => {
    setOpen(false);
    btnRef.current?.focus();
  }, []);

  const commit = useCallback((next: string) => {
    onChange(next);
    closeAndRefocus();
  }, [onChange, closeAndRefocus]);

  // Close on outside click, dismiss on Escape, reposition on scroll/resize.
  useEffect(() => {
    if (!open) return;
    updatePos();

    const handleOutside = (e: MouseEvent) => {
      if (
        btnRef.current && !btnRef.current.contains(e.target as Node) &&
        dropRef.current && !dropRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const handleEscapeCapture = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Keeps the surrounding Modal's own Escape handler from firing, so a menu
      // dismissal does not also discard the dialog.
      e.stopPropagation();
      setOpen(false);
      btnRef.current?.focus();
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
  }, [open, updatePos]);

  // A keypress that opens the menu cannot focus an option in the same tick,
  // because the options do not exist until this commit lands.
  useEffect(() => {
    if (!open) return;
    const index = pendingFocus.current;
    pendingFocus.current = null;
    if (index !== null) focusOption(index);
  }, [open, focusOption]);

  const handleTriggerKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const target = e.key === "ArrowDown" ? 0 : options.length - 1;
    if (open) {
      focusOption(target);
      return;
    }
    pendingFocus.current = target;
    updatePos();
    setOpen(true);
  };

  const handleMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = options.findIndex(
      (o) => optionNodes.current.get(o.value) === document.activeElement,
    );

    switch (e.key) {
      case "ArrowDown":
        // index === -1 (focus is not on an option yet) lands on the first.
        e.preventDefault();
        focusOption(index + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        focusOption(index <= 0 ? options.length - 1 : index - 1);
        break;
      case "Home":
        e.preventDefault();
        focusOption(0);
        break;
      case "End":
        e.preventDefault();
        focusOption(options.length - 1);
        break;
      case "Enter":
      case " ":
        if (index < 0) return;
        // Also suppresses the click a button would synthesize from this key,
        // which would otherwise commit a second time.
        e.preventDefault();
        commit(options[index].value);
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
        onClick={() => { if (!open) updatePos(); setOpen(!open); }}
        onKeyDown={handleTriggerKeyDown}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className={`w-full h-14 px-4 bg-white text-left text-foreground rounded-[4px] border border-outline cursor-pointer focus:outline-none focus:border-primary focus:border-2 transition-colors text-sm flex items-center justify-between gap-2 ${triggerClassName ?? ""}`}
      >
        <span className={selectedLabel ? "text-foreground" : "text-muted-foreground"}>
          {selectedLabel || placeholder}
        </span>
        <ChevronDown className={`h-4 w-4 text-muted-foreground shrink-0 transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
      </button>

      {open && createPortal(
        <div
          ref={dropRef}
          id={menuId}
          onKeyDown={handleMenuKeyDown}
          style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width }}
          className="z-[100] bg-white rounded-[12px] border border-outline-variant shadow-lg max-h-64 overflow-y-auto py-1"
        >
          {options.map((option) => (
            <button
              key={option.value}
              ref={(node) => {
                if (node) optionNodes.current.set(option.value, node);
                else optionNodes.current.delete(option.value);
              }}
              type="button"
              onClick={() => commit(option.value)}
              aria-current={option.value === value ? "true" : undefined}
              className={`w-full text-left px-4 py-3 text-sm flex items-center justify-between gap-2 cursor-pointer transition-all duration-100 ${
                option.value === value
                  ? "bg-primary/8 text-primary font-medium"
                  : "text-foreground hover:bg-surface-container"
              }`}
            >
              <span>{option.label}</span>
              {option.value === value && <Check className="h-4 w-4 text-primary shrink-0" />}
            </button>
          ))}
        </div>,
        portalContainer ?? document.body,
      )}
    </div>
  );
}
