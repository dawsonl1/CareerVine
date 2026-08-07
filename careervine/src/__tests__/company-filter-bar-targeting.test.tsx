// @vitest-environment jsdom
/**
 * The Companies secondary filter row's target-company control (CAR-252).
 *
 * The page lists `in_play` — companies you target UNION companies you already know
 * someone at — and until this control there was no way to separate the two. The
 * status chips cannot do it: every one of them ANDs on `target.status`, so they can
 * only ever narrow WITHIN the targets.
 *
 * This file pins what a unit test of `filterCompanies` cannot see: that the control
 * exists in the row, offers both sides, reports them to the page, and counts once
 * on the Filters badge no matter how many values are picked.
 * `company-filters.test.ts` owns the predicates and the URL round-trip;
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
// assert what the target control offers.
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
      tierOptions={[]}
    />
  );
}

/** Open the secondary drawer, which is collapsed until something in it is active. */
function openDrawer() {
  fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
}

const targetTrigger = () => screen.getByRole("combobox", { name: "Filter by target company" });
const optionLabels = () => screen.getAllByRole("option").map((o) => o.textContent?.trim());

describe("Companies filter bar: target company", () => {
  it("offers both sides of the dimension on one control", () => {
    render(<Bar />);
    openDrawer();
    fireEvent.click(targetTrigger());
    expect(optionLabels()).toEqual(["Any company", "Target company", "Not a target"]);
  });

  it("reports the selected side to the page and counts as one active filter", () => {
    const onChange = vi.fn();
    render(<Bar onChange={onChange} />);
    openDrawer();
    fireEvent.click(targetTrigger());
    fireEvent.click(screen.getByRole("option", { name: "Not a target" }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ targeting: ["untargeted"] }));
    // The badge on the Filters toggle counts the facet once, not once per value.
    expect(screen.getByRole("button", { name: /Filters/ }).textContent).toContain("1");
  });

  it("still counts as one filter with both sides picked", () => {
    const onChange = vi.fn();
    render(<Bar onChange={onChange} />);
    openDrawer();
    fireEvent.click(targetTrigger());
    fireEvent.click(screen.getByRole("option", { name: "Target company" }));
    fireEvent.click(screen.getByRole("option", { name: "Not a target" }));

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ targeting: ["target", "untargeted"] }),
    );
    expect(screen.getByRole("button", { name: /Filters/ }).textContent).toContain("1");
  });

  it("sits ahead of the other facet menus, nearest the status chips it qualifies", () => {
    // Placement is the argument for why the control is legible next to the chip
    // row: it is the coarsest cut, and the chips above it all imply "target".
    render(<Bar />);
    openDrawer();
    const names = screen
      .getAllByRole("combobox")
      .map((c) => c.getAttribute("aria-label"));
    expect(names[0]).toBe("Filter by target company");
  });
});
