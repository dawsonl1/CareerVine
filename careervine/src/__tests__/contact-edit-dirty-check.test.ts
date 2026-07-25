import { describe, it, expect } from "vitest";
import { serializeForm, type FormSnapshot } from "@/components/contacts/contact-edit-modal";

/**
 * Backs the unsaved-changes guard the Edit Contact modal gained in CAR-198. Its
 * failure mode is not a crash but a nuisance: any normalization miss makes a
 * freshly opened, untouched form read as dirty, so every dismissal warns and the
 * confirmation stops meaning anything.
 */
const base = (): FormSnapshot => ({
  formData: { name: "Ada Lovelace", industry: "Software", location_city: "" },
  companies: [{ company_name: "Analytical Engines", title: "Engineer", is_current: true, start_month: "1843-01", end_month: "" }],
  emails: [{ email: "ada@example.com", is_primary: true }],
  phones: [{ phone: "555-0100", type: "mobile", is_primary: true }],
  preferredContactKey: "email-0",
  selectedTagIds: [7, 2, 19],
});

describe("serializeForm", () => {
  it("treats an untouched snapshot as unchanged", () => {
    expect(serializeForm(base())).toBe(serializeForm(base()));
  });

  it("ignores tag order, which reflects the order tags were added rather than an edit", () => {
    expect(serializeForm({ ...base(), selectedTagIds: [19, 7, 2] })).toBe(serializeForm(base()));
  });

  it("ignores formData key order", () => {
    const reordered: FormSnapshot = {
      ...base(),
      formData: { location_city: "", industry: "Software", name: "Ada Lovelace" },
    };
    expect(serializeForm(reordered)).toBe(serializeForm(base()));
  });

  it.each([
    ["a scalar field", { formData: { ...base().formData, industry: "Mathematics" } }],
    ["adding a tag", { selectedTagIds: [7, 2, 19, 23] }],
    ["removing a tag", { selectedTagIds: [7, 2] }],
    ["the preferred contact", { preferredContactKey: "phone-0" }],
    ["an email address", { emails: [{ email: "ada@lovelace.test", is_primary: true }] }],
    ["a phone type", { phones: [{ phone: "555-0100", type: "work", is_primary: true }] }],
    ["clearing the company list", { companies: [] }],
  ])("detects an edit to %s", (_label, patch) => {
    expect(serializeForm({ ...base(), ...patch })).not.toBe(serializeForm(base()));
  });

  it("distinguishes an empty string from a missing entry rather than collapsing both", () => {
    expect(serializeForm({ ...base(), emails: [] })).not.toBe(
      serializeForm({ ...base(), emails: [{ email: "", is_primary: true }] }),
    );
  });
});
