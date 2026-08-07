// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { mockAuthProviderModule } from "./helpers/mock-auth-provider";
import type { CompanyPerson } from "@/lib/company-queries";
import type { LocationBlock, LocationTabsData } from "@/lib/company-scopes";
import type { PipelineState } from "@/lib/pipeline-state";
import type { PipelineActions } from "@/hooks/use-pipeline-autosave";

/**
 * CAR-241. The company roster used to render `[...current, ...former]` as one
 * list, so people who left the company outnumbered and buried the ones still
 * inside it. Former employees now live in their own group, collapsed by
 * default — and the search must still reach into it, or a name that IS in the
 * roster comes back looking absent.
 */

vi.mock("@/components/auth-provider", () => mockAuthProviderModule());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
// Owns its own fetch and renders null without candidates — irrelevant here.
vi.mock("@/components/companies/discovery-card", () => ({
  DiscoveryCard: () => null,
}));

import { PipelineLayout } from "@/components/companies/pipeline/pipeline-layout";

function person(id: number, name: string, over: Partial<CompanyPerson> = {}): CompanyPerson {
  return {
    contact_id: id,
    name,
    photo_url: null,
    headline: null,
    persona: null,
    network_status: "prospect",
    is_alum: false,
    review_note: null,
    selection_reason: null,
    last_scraped_at: null,
    linkedin_url: null,
    stage: null,
    email: null,
    last_interaction: null,
    adjacency_score: null,
    roles: [],
    current_position: null,
    ...over,
  };
}

function block(over: Partial<LocationBlock> = {}): LocationBlock {
  return {
    key: "all",
    label: "All contacts",
    tabLabel: "All",
    location_id: null,
    contactCount: 0,
    isTargeted: false,
    status: null,
    next_app_date: null,
    app_window_text: null,
    notes: [],
    current: [],
    former: [],
    bench: [],
    ...over,
  };
}

const STATE: PipelineState = { companyTargeted: false, officeTargeted: {}, scopes: {} };
const ACTIONS: PipelineActions = {
  setScopeTargeted: vi.fn(),
  patchActiveCycle: vi.fn(),
  selectStage: vi.fn(),
  setActiveCycle: vi.fn(),
  startNextCycle: vi.fn(),
  deleteCycle: vi.fn(),
};

function renderRoster(all: LocationBlock) {
  const tabs: LocationTabsData = { all, companyWide: null, offices: [], unassigned: [] };
  return render(
    <PipelineLayout
      userId="u-1"
      companyId={7}
      tabs={tabs}
      companyName="Acme"
      totalContacts={all.current.length + all.former.length}
      linkedinUrl={null}
      offices={[]}
      state={STATE}
      actions={ACTIONS}
      saveStatus="idle"
      scope="all"
      onScopeChange={vi.fn()}
      gmailConnected={false}
      onCompose={vi.fn()}
      onSetTier={vi.fn()}
      jobChangeIds={new Set()}
      onOfficesChanged={vi.fn()}
    />,
  );
}

const MIXED = block({
  current: [person(1, "Cora Current"), person(2, "Cal Current", { network_status: "active" })],
  former: [person(3, "Fern Former"), person(4, "Finn Former")],
});

function search(value: string) {
  fireEvent.change(screen.getByPlaceholderText("Search contacts"), { target: { value } });
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("company page roster: current vs former employees", () => {
  it("hides former employees behind a collapsed group, and keeps current ones visible", () => {
    renderRoster(MIXED);

    expect(screen.getByText("Cora Current")).toBeTruthy();
    expect(screen.getByText("Cal Current")).toBeTruthy();
    expect(screen.queryByText("Fern Former")).toBeNull();
    expect(screen.queryByText("Finn Former")).toBeNull();

    const toggle = screen.getByRole("button", { name: "Former employees (2)" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("reveals former employees on click, tier-grouped like the current list", () => {
    renderRoster(
      block({
        current: [person(1, "Cora Current")],
        former: [
          person(3, "Fern Former", { network_status: "active" }),
          person(4, "Finn Former"),
        ],
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Former employees (2)" }));

    expect(screen.getByText("Fern Former")).toBeTruthy();
    expect(screen.getByText("Finn Former")).toBeTruthy();
    // Both tiers exist among the former group, so both headings render inside it
    // (the teal prospect ring is only legible when the tiers are not interleaved).
    expect(screen.getAllByText("Your network").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Prospects").length).toBeGreaterThan(0);
  });

  it("surfaces a former-employee search hit without needing the group opened", () => {
    renderRoster(MIXED);
    search("Fern");

    expect(screen.getByText("Fern Former")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Former employees (1)" }).getAttribute("aria-expanded")).toBe("true");
    // The current-employee area is empty for this query and must say so rather
    // than read as an empty roster.
    expect(screen.getByText("No current employees match.")).toBeTruthy();
    expect(screen.queryByText("No contacts match.")).toBeNull();
  });

  it("re-collapses the former group when the search is cleared", () => {
    renderRoster(MIXED);
    search("Fern");
    // Sequenced on the expansion actually happening — asserting only the
    // collapsed end state passes just as well when search never expands at all.
    expect(screen.getByText("Fern Former")).toBeTruthy();
    search("");

    expect(screen.queryByText("Fern Former")).toBeNull();
    expect(screen.getByRole("button", { name: "Former employees (2)" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Cora Current")).toBeTruthy();
  });

  it("never claims a former-only company has no contacts", () => {
    renderRoster(block({ former: [person(3, "Fern Former")] }));

    expect(screen.queryByText("No contacts at this office yet.")).toBeNull();
    expect(screen.getByText("Nobody here works at this company now.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Former employees (1)" })).toBeTruthy();
  });

  it("keeps the empty state for a company with nobody in either group", () => {
    renderRoster(block({}));

    expect(screen.getByText("No contacts at this office yet.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Former employees/ })).toBeNull();
  });

  it("counts collapsed former employees in the section total", () => {
    const { container } = renderRoster(MIXED);
    const heading = screen.getByText("Contacts");
    const count = heading.parentElement?.querySelector("span.tabular-nums");

    expect(container).toBeTruthy();
    expect(count?.textContent).toBe("4");
  });
});
