// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { mockAuthProviderModule } from "./helpers/mock-auth-provider";
import type { CompanyPerson } from "@/lib/company-queries";
import type { LocationBlock, LocationTabsData } from "@/lib/company-scopes";
import type { PipelineState } from "@/lib/pipeline-state";
import type { PipelineActions } from "@/hooks/use-pipeline-autosave";

/**
 * CAR-255. The Active outreach stage's "Contact made with …" record was built
 * from `[...current, ...former]`, narrowed by the roster search box. So an email
 * to somebody who left the company years ago was presented as traction there,
 * and typing in Search contacts rewrote what the stage claimed had happened.
 *
 * Both halves are asserted here, because they share one expression and a fix for
 * either alone leaves the other live.
 */

vi.mock("@/components/auth-provider", () => mockAuthProviderModule());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
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
    isTargeted: true,
    status: "outreach_active",
    next_app_date: null,
    app_window_text: null,
    notes: [],
    current: [],
    former: [],
    bench: [],
    ...over,
  };
}

const ACTIONS: PipelineActions = {
  setScopeTargeted: vi.fn(),
  patchActiveCycle: vi.fn(),
  selectStage: vi.fn(),
  setActiveCycle: vi.fn(),
  startNextCycle: vi.fn(),
  deleteCycle: vi.fn(),
};

/**
 * Targeted, sitting on Active outreach, with that stage expanded — the exact
 * state the screenshot in the ticket shows. `companyWide` is what makes the
 * panel render its pipeline instead of the "mark as a target" prompt.
 */
function renderPipeline(all: LocationBlock) {
  const companyWide = block({ key: "company", tabLabel: "Company", isTargeted: true });
  const tabs: LocationTabsData = { all, companyWide, offices: [], unassigned: [] };
  const state: PipelineState = {
    companyTargeted: true,
    officeTargeted: {},
    scopes: {},
  };
  return render(
    <PipelineLayout
      userId="u-1"
      companyId={7}
      tabs={tabs}
      companyName="Acme"
      totalContacts={all.current.length + all.former.length}
      linkedinUrl={null}
      offices={[]}
      state={state}
      pipelineFailed={false}
      onRetryPipeline={() => {}}
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

/** The record renders first names only, so match the "Contact made with" row. */
function recordedNames(): string[] {
  return screen
    .queryAllByText(/^Contact made with$/)
    .map((el) => el.parentElement?.textContent?.trim() ?? "");
}

function search(value: string) {
  fireEvent.change(screen.getByPlaceholderText("Search contacts"), { target: { value } });
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("Active outreach record: current employees only", () => {
  it("records a contacted CURRENT employee", () => {
    renderPipeline(block({ current: [person(1, "Cora Current", { stage: "contacted" })] }));

    const record = recordedNames();
    expect(record.length).toBe(1);
    expect(record[0]).toContain("Cora");
  });

  it("never records a contacted FORMER employee", () => {
    renderPipeline(
      block({
        current: [person(1, "Cora Current", { stage: "contacted" })],
        former: [
          person(3, "Fern Former", { stage: "replied" }),
          person(4, "Finn Former", { stage: "call_scheduled" }),
        ],
      }),
    );

    const record = recordedNames().join(" ");
    expect(record).toContain("Cora");
    expect(record).not.toContain("Fern");
    expect(record).not.toContain("Finn");
  });

  it("says no outreach when only former employees have been contacted", () => {
    renderPipeline(
      block({
        current: [person(1, "Cora Current")],
        former: [person(3, "Fern Former", { stage: "replied" })],
      }),
    );

    expect(screen.getByText("No outreach logged yet.")).toBeTruthy();
    expect(recordedNames()).toEqual([]);
  });

  it("keeps the record intact while the roster search narrows the list", () => {
    renderPipeline(
      block({
        current: [
          person(1, "Cora Current", { stage: "contacted" }),
          person(2, "Cal Current", { stage: "replied" }),
        ],
      }),
    );
    // Sequenced on the search actually taking effect on the roster, so this
    // cannot pass by the search silently doing nothing at all.
    search("Cora");
    expect(screen.queryByText("Cal Current")).toBeNull();

    const record = recordedNames().join(" ");
    expect(record).toContain("Cora");
    expect(record).toContain("Cal");
  });

  it("keeps the record intact when the search matches nobody", () => {
    renderPipeline(block({ current: [person(1, "Cora Current", { stage: "contacted" })] }));
    search("zzzzzz");
    expect(screen.getByText("No contacts match.")).toBeTruthy();

    expect(recordedNames().join(" ")).toContain("Cora");
  });

  it("excludes a bounced current employee: the send failed, so no contact was made", () => {
    renderPipeline(
      block({
        current: [
          person(1, "Cora Current", { stage: "bounced" }),
          person(2, "Cal Current", { stage: "not_contacted" }),
        ],
      }),
    );

    expect(screen.getByText("No outreach logged yet.")).toBeTruthy();
  });

  it("excludes an archived (bench) contact, matching the list traction chip", () => {
    renderPipeline(
      block({
        current: [person(1, "Cora Current", { stage: "contacted" })],
        bench: [person(9, "Ben Bench", { network_status: "bench", stage: "replied" })],
      }),
    );

    const record = recordedNames().join(" ");
    expect(record).toContain("Cora");
    expect(record).not.toContain("Ben");
  });
});
