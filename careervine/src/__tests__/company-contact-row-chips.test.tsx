// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { mockAuthProviderModule } from "./helpers/mock-auth-provider";
import type { CompanyPerson } from "@/lib/company-queries";
import type { LocationBlock, LocationTabsData } from "@/lib/company-scopes";
import type { PipelineState } from "@/lib/pipeline-state";
import type { PipelineActions } from "@/hooks/use-pipeline-autosave";

/**
 * The contact row tells the truth about conversations, and offers LinkedIn
 * (CAR-267).
 *
 * Production symptom: Spencer Hintze's row on the Lucid Software page wore a
 * "Call done" chip off one meeting typed `text` ("LinkedIn chat"). The chip row
 * now renders one chip per distinct conversation kind, so the text exchange
 * reads "Texted" and a person with a call AND a text gets both chips. The same
 * row also gains a LinkedIn anchor in the detail column — the roster previously
 * offered no clickable LinkedIn outside the expanded preview.
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
    conversations: { past: null, upcoming: null },
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
      onDeleteCompany={vi.fn()}
    />,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("contact row conversation chips (CAR-267)", () => {
  it("shows Texted, not Call done, for a call_done stage backed only by a text exchange", () => {
    renderRoster(
      block({
        current: [
          person(1, "Spencer Hintze", {
            network_status: "active",
            stage: "call_done",
            conversations: {
              past: { kind: "text", kinds: ["text"], allCalls: false },
              upcoming: null,
            },
          }),
        ],
      }),
    );
    expect(screen.getByText("Texted")).toBeTruthy();
    expect(screen.queryByText("Call done")).toBeNull();
  });

  it("gives a mixed history one chip per distinct kind", () => {
    renderRoster(
      block({
        current: [
          person(1, "Kate Ross", {
            stage: "call_done",
            conversations: {
              past: { kind: "call", kinds: ["call", "career-fair"], allCalls: false },
              upcoming: null,
            },
          }),
        ],
      }),
    );
    expect(screen.getByText("Call done")).toBeTruthy();
    expect(screen.getByText("Career fair")).toBeTruthy();
  });

  it("keeps the plain stage chip when an override asserts the stage with no events", () => {
    renderRoster(
      block({
        current: [
          person(1, "Owen Blake", {
            stage: "call_done",
            conversations: { past: null, upcoming: null },
          }),
        ],
      }),
    );
    expect(screen.getByText("Call done")).toBeTruthy();
  });

  it("words an upcoming conversation as scheduled, per kind", () => {
    renderRoster(
      block({
        current: [
          person(1, "Ravi Nair", {
            stage: "call_scheduled",
            conversations: {
              past: null,
              upcoming: { kind: "career-fair", kinds: ["career-fair"], allCalls: false },
            },
          }),
        ],
      }),
    );
    expect(screen.getByText("Career fair scheduled")).toBeTruthy();
    expect(screen.queryByText("Call scheduled")).toBeNull();
  });
});

describe("contact row LinkedIn link (CAR-267)", () => {
  it("renders a real anchor to the contact's profile in the detail column", () => {
    renderRoster(
      block({
        current: [
          person(1, "Spencer Hintze", {
            linkedin_url: "https://www.linkedin.com/in/spencer-hintze",
          }),
        ],
      }),
    );
    const anchor = screen
      .getAllByTitle("Open Spencer Hintze's LinkedIn profile")
      .find((el) => el.tagName === "A") as HTMLAnchorElement | undefined;
    expect(anchor).toBeTruthy();
    expect(anchor!.getAttribute("href")).toBe("https://www.linkedin.com/in/spencer-hintze");
    expect(anchor!.getAttribute("target")).toBe("_blank");
  });

  it("offers no dead affordance when the contact has no LinkedIn on file", () => {
    renderRoster(block({ current: [person(1, "Cora Current")] }));
    expect(screen.queryByText("LinkedIn")).toBeNull();
  });
});
