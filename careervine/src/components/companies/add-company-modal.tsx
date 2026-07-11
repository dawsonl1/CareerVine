"use client";

/**
 * Create-company modal for /companies (CAR-34). Goes through the shared
 * find-or-create identity path, so adding a company that already exists
 * opens it instead of duplicating it. The company is always added to the
 * user's targets so it lands in the default Targets view.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { addCompanyManually } from "@/lib/company-queries";

const INPUT_CLASSES =
  "h-10 px-3 w-full rounded-lg bg-surface-container-highest text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary/40";

interface AddCompanyModalProps {
  userId: string;
  onClose: () => void;
}

export function AddCompanyModal({ userId, onClose }: AddCompanyModalProps) {
  const router = useRouter();
  const { success: toastSuccess, error: toastError } = useToast();
  const [name, setName] = useState("");
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [country, setCountry] = useState("United States");
  const [saving, setSaving] = useState(false);

  const dirty = Boolean(name.trim() || linkedinUrl.trim() || city.trim() || state.trim());

  const submit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      const result = await addCompanyManually(userId, { name, linkedin_url: linkedinUrl, city, state, country });
      toastSuccess(
        result.alreadyTargeted
          ? `${result.companyName} is already in your companies, opening it`
          : `Added ${result.companyName}`,
      );
      router.push(`/companies/${result.companyId}`);
    } catch {
      toastError("Failed to add company");
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title="Add company" size="sm" hasUnsavedChanges={dirty && !saving}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="space-y-4"
      >
        <div>
          <label htmlFor="add-company-name" className="block text-sm font-medium text-on-surface mb-1.5">
            Company name
          </label>
          <input
            id="add-company-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Figma"
            autoFocus
            className={INPUT_CLASSES}
          />
        </div>

        <div>
          <label htmlFor="add-company-linkedin" className="block text-sm font-medium text-on-surface mb-1.5">
            LinkedIn URL <span className="font-normal text-on-surface-variant">(optional)</span>
          </label>
          <input
            id="add-company-linkedin"
            type="url"
            value={linkedinUrl}
            onChange={(e) => setLinkedinUrl(e.target.value)}
            placeholder="https://www.linkedin.com/company/…"
            className={INPUT_CLASSES}
          />
        </div>

        <div>
          <span className="block text-sm font-medium text-on-surface mb-1.5">
            Office location <span className="font-normal text-on-surface-variant">(optional)</span>
          </span>
          <div className="grid gap-2 sm:grid-cols-3">
            <input
              type="text"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder="City"
              aria-label="City"
              className={INPUT_CLASSES}
            />
            <input
              type="text"
              value={state}
              onChange={(e) => setState(e.target.value)}
              placeholder="State/Region"
              aria-label="State or region"
              className={INPUT_CLASSES}
            />
            <input
              type="text"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              placeholder="Country"
              aria-label="Country"
              className={INPUT_CLASSES}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="text" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={!name.trim() || saving}>
            {saving ? "Adding…" : "Add company"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
