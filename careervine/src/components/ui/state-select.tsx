/**
 * Country-aware state field for contact forms.
 *
 * For a US contact it renders a normalized dropdown of the 50 states + DC
 * (option values are canonical full names), so hand-entered state matches what
 * the scrape/import pipeline stores and locations don't split into "CA" vs
 * "California" duplicates. For any other country it falls back to a free-text
 * State / Province input so international contacts still work.
 */

"use client";

import { Select } from "@/components/ui/select";
import { US_STATE_OPTIONS, isUnitedStates } from "@/lib/us-states";
import { inputClasses } from "@/lib/form-styles";

interface StateSelectProps {
  value: string;
  onChange: (value: string) => void;
  /** Sibling country value — decides dropdown (US) vs free text (international). */
  country: string;
  required?: boolean;
}

export function StateSelect({ value, onChange, country, required }: StateSelectProps) {
  if (!isUnitedStates(country)) {
    return (
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={inputClasses}
        placeholder="State / Province"
      />
    );
  }

  // Keep an unrecognized legacy value (e.g. an abbreviation that wasn't healed
  // on load) visible as its own option so it's never silently dropped.
  const options =
    value && !US_STATE_OPTIONS.some((o) => o.value === value)
      ? [...US_STATE_OPTIONS, { value, label: value }]
      : US_STATE_OPTIONS;

  return (
    <Select
      value={value}
      onChange={onChange}
      options={options}
      placeholder="Select state"
      required={required}
      triggerClassName="!bg-surface-container-low"
    />
  );
}
