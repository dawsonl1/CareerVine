// @vitest-environment jsdom
/**
 * The Companies secondary filter row's contact-presence control (CAR-248).
 *
 * The row used to carry TWO controls over the same dimension: an ANDing
 * "Contact works there now" chip beside an ORing dropdown offering "With
 * contacts" / "No contacts yet". They read as overlapping criteria, so the chip
 * was retired and its meaning became a third value in the dropdown.
 *
 * This file pins the part a unit test of `filterCompanies` cannot see: that the
 * user is offered exactly one control for the dimension, with all three values
 * on it. `company-filters.test.ts` owns the predicates and the URL migration;
 * `multi-select.test.tsx` owns the popover mechanics.
 *
 * Plain matchers throughout — the project does not load jest-dom.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import CompanyFilterBar from "@/components/companies/company-filter-bar";
import { EMPTY_COMPANY_FILTERS, type CompanyFilters } from "@/lib/company-filters";

// The bar reads school affinity to decide whether the alumni controls render at
// all. Mocked to "no school" so nothing alumni-shaped is in the row while we
// assert what the contacts control offers.
vi.mock("@/hooks/use-alumni-affinity", () => ({
  useAlumniAffinity: () => ({ hasAffinity: false, abbr: null, name: null }),
}));

afterEach(cleanup);

/** Uncontrolled harness: picking values has to accumulate to be worth asserting. */
function Bar({ onChange }: { onChange?: (f: CompanyFilters) => void } = {}) {
  const [filters, setFilters] = useState<CompanyFilters>(EMPTY_COMPANY_FILTERS);
  return (
    <CompanyFilterBar
      filters={filters}
      onFiltersChange={(f) => {
        setFilters(f);
        onChange?.(f);
      }}
      locationGroups={[]} noLocationCount={0}
    />
  );
}

/** Open the secondary drawer, which is collapsed until something in it is active. */
function openDrawer() {
  fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
}

const contactsTrigger = () => screen.getByRole("combobox", { name: "Filter by contacts" });
const optionLabels = () => screen.getAllByRole("option").map((o) => o.textContent?.trim());

describe("Companies filter bar: contact presence", () => {
  it("offers all three values on one control", () => {
    render(<Bar />);
    openDrawer();
    fireEvent.click(contactsTrigger());
    expect(optionLabels()).toEqual([
      "Any contacts",
      "Contact works there now",
      "Contact worked there before",
      "No contacts yet",
    ]);
  });

  it("has no separate works-there-now chip competing with the dropdown", () => {
    // The regression this guards: re-adding a second control over the same
    // dimension. A chip is a button; the dropdown row is an option, so querying
    // by role is what tells the two apart.
    render(<Bar />);
    openDrawer();
    const chips = screen.getAllByRole("button").map((b) => b.textContent?.trim() ?? "");
    expect(chips.filter((t) => /works there now/i.test(t))).toEqual([]);
  });

  it("reports the selected value to the page and counts as one active filter", () => {
    const onChange = vi.fn();
    render(<Bar onChange={onChange} />);
    openDrawer();
    fireEvent.click(contactsTrigger());
    fireEvent.click(screen.getByRole("option", { name: "Contact worked there before" }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ contacts: ["former"] }));
    // The badge on the Filters toggle counts the facet once, not once per value.
    expect(screen.getByRole("button", { name: /Filters/ }).textContent).toContain("1");
  });

  it("keeps the two halves of the retired \"with contacts\" selectable together", () => {
    const onChange = vi.fn();
    render(<Bar onChange={onChange} />);
    openDrawer();
    fireEvent.click(contactsTrigger());
    fireEvent.click(screen.getByRole("option", { name: "Contact works there now" }));
    fireEvent.click(screen.getByRole("option", { name: "Contact worked there before" }));

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ contacts: ["current", "former"] }),
    );
  });
});
