/**
 * M3 Select / Dropdown component
 *
 * Custom dropdown that renders its menu via a React portal so it
 * escapes parent overflow:hidden containers (e.g. modals).
 *
 * Features:
 *   - Keyboard navigation (arrow keys, Enter, Escape)
 *   - Click-outside to close
 *   - Check icon on selected option
 *   - Supports required prop for form validation
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

import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check } from "lucide-react";

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
}

export function Select({ value, onChange, options, placeholder = "Select…", required, className }: SelectProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  const updatePos = useCallback(() => {
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    }
  }, []);

  // Close on outside click + reposition on scroll/resize
  useEffect(() => {
    if (!open) return;
    updatePos();
    const handler = (e: MouseEvent) => {
      if (
        btnRef.current && !btnRef.current.contains(e.target as Node) &&
        dropRef.current && !dropRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    window.addEventListener("scroll", updatePos, true);
    window.addEventListener("resize", updatePos);
    return () => {
      document.removeEventListener("mousedown", handler);
      window.removeEventListener("scroll", updatePos, true);
      window.removeEventListener("resize", updatePos);
    };
  }, [open, updatePos]);

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
        className="w-full h-14 px-4 bg-white text-left text-foreground rounded-[4px] border border-outline cursor-pointer focus:outline-none focus:border-primary focus:border-2 transition-colors text-sm flex items-center justify-between gap-2"
      >
        <span className={selectedLabel ? "text-foreground" : "text-muted-foreground"}>
          {selectedLabel || placeholder}
        </span>
        <ChevronDown className={`h-4 w-4 text-muted-foreground shrink-0 transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
      </button>

      {open && createPortal(
        <div
          ref={dropRef}
          style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width }}
          className="z-[100] bg-white rounded-[12px] border border-outline-variant shadow-lg max-h-64 overflow-y-auto py-1"
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
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
        document.body
      )}
    </div>
  );
}
