"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import {
  addCompanyOfficeLocation,
  deleteCompanyOffice,
  type CompanyOffice,
} from "@/lib/company-queries";

const inputClassName =
  "h-10 px-3 rounded-lg bg-surface-container-high text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary/40";

/**
 * Add/remove office locations (phantom-office correction) — ported from
 * the pre-CAR-6 company page into the pipeline layout.
 */
export function ManageOfficesPanel({
  companyId,
  offices,
  onChanged,
}: {
  companyId: number;
  offices: CompanyOffice[];
  onChanged: () => void;
}) {
  const { success: toastSuccess, error: toastError } = useToast();
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [country, setCountry] = useState("United States");
  const [adding, setAdding] = useState(false);

  const addOffice = async () => {
    const trimmedCity = city.trim();
    const trimmedState = state.trim();
    const trimmedCountry = country.trim() || "United States";
    if (!trimmedCity && !trimmedState && !trimmedCountry) {
      toastError("Add at least a country for the office");
      return;
    }

    setAdding(true);
    try {
      const result = await addCompanyOfficeLocation(companyId, {
        city: trimmedCity,
        state: trimmedState,
        country: trimmedCountry,
      });
      toastSuccess(result.added ? `Added ${result.label} office` : `${result.label} office already exists`);
      setCity("");
      setState("");
      setCountry("United States");
      onChanged();
    } catch {
      toastError("Failed to add office");
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="rounded-xl border border-outline-variant/40 bg-surface-container-lowest p-4 space-y-4">
      <p className="text-xs text-on-surface-variant">
        Deleting an office clears locations that were inferred from it (profile matches). Locations
        stated on someone&apos;s own experience are kept.
      </p>
      <div className="grid gap-2 sm:grid-cols-4">
        <input
          type="text"
          value={city}
          onChange={(e) => setCity(e.target.value)}
          placeholder="City (optional)"
          className={inputClassName}
        />
        <input
          type="text"
          value={state}
          onChange={(e) => setState(e.target.value)}
          placeholder="State/Region (optional)"
          className={inputClassName}
        />
        <input
          type="text"
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          placeholder="Country"
          className={inputClassName}
        />
        <Button onClick={addOffice} disabled={adding || !country.trim()}>
          <Plus className="w-4 h-4 mr-1.5" /> {adding ? "Adding…" : "Add office"}
        </Button>
      </div>
      <div className="flex gap-2 flex-wrap">
        {offices.length === 0 && (
          <span className="text-sm text-on-surface-variant">No offices recorded yet.</span>
        )}
        {offices.map((o) => (
          <span
            key={o.id}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-container-high text-sm text-on-surface"
          >
            {o.label}
            {o.source === "manual" && <span className="text-[10px] text-on-surface-variant">(manual)</span>}
            <button
              onClick={async () => {
                try {
                  await deleteCompanyOffice(o, companyId);
                  toastSuccess(`Removed ${o.label} office`);
                  onChanged();
                } catch {
                  toastError("Failed to remove office");
                }
              }}
              className="text-on-surface-variant hover:text-error"
              title="Remove this office"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
