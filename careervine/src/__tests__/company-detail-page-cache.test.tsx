// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import { Suspense } from "react";
import { mockAuthProviderModule } from "./helpers/mock-auth-provider";
import { mockToastModule } from "./helpers/mock-toast";
import { resetListCache } from "@/lib/list-cache";
import { invalidateCompanyScopes } from "@/lib/company-detail-cache";

/**
 * CAR-268. Two claims, and the second is the one a cache-only test would miss.
 *
 *  1. Coming back does not re-read the roster.
 *  2. The PIPELINE is re-read every time regardless, because it seeds
 *     `usePipelineAutosave`'s reducer and a snapshot of it predates the user's
 *     own unflushed edits. Caching it is the bug this design exists to avoid,
 *     so a test that only counted "requests on return" would happily pass on a
 *     version that cached it.
 *
 * `PipelineLayout` is stubbed. What changed is the PAGE's orchestration, and
 * the real layout drags in the whole roster tree without saying anything about
 * which reads fired.
 */

const q = vi.hoisted(() => ({
  fetchCompanyScopes: vi.fn(),
  loadPipeline: vi.fn(),
  getFreshJobChangeContactIds: vi.fn(async () => new Set<number>()),
}));

vi.mock("@/lib/company-scopes", () => ({ fetchCompanyScopes: q.fetchCompanyScopes }));
vi.mock("@/lib/pipeline-queries", () => ({ loadPipeline: q.loadPipeline }));
vi.mock("@/lib/queries", () => ({
  getFreshJobChangeContactIds: q.getFreshJobChangeContactIds,
  activateContact: vi.fn(),
}));
vi.mock("@/lib/company-queries", () => ({
  demoteContactToBench: vi.fn(),
  promoteContactToProspect: vi.fn(),
}));
vi.mock("@/components/auth-provider", () => mockAuthProviderModule());
vi.mock("@/components/navigation", () => ({ __esModule: true, default: () => <nav /> }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/companies/42",
}));
vi.mock("@/components/ui/toast", () => mockToastModule());
vi.mock("@/components/compose-email-context", () => ({
  useCompose: () => ({ openCompose: vi.fn(), gmailConnected: true }),
}));
vi.mock("@/components/onboarding/onboarding-context", () => ({
  useOnboarding: () => ({ state: "done" }),
}));
vi.mock("@/hooks/use-alumni-affinity", () => ({
  useAlumniAffinity: () => ({ hasAffinity: false, university: null }),
}));
vi.mock("@/hooks/use-pipeline-autosave", () => ({
  usePipelineAutosave: ({ loaded }: { loaded: unknown }) => ({
    state: loaded ? { companyTargeted: false, officeTargeted: {}, scopes: {} } : null,
    saveStatus: "idle",
    actions: {},
  }),
}));

/** Reports what the page handed down, which is the thing under test. */
vi.mock("@/components/companies/pipeline/pipeline-layout", () => ({
  PipelineLayout: ({ tabs, state }: { tabs: unknown; state: unknown }) => (
    <div>
      {tabs ? <span>roster-ready</span> : null}
      {state ? <span>pipeline-ready</span> : <span>pipeline-loading</span>}
    </div>
  ),
}));

import CompanyPipelinePage from "@/app/companies/[id]/page";

const SCOPES = {
  company: { id: 42, name: "Acme", logo_url: null, linkedin_url: null },
  tabs: { all: { bench: [] }, offices: [], companyWide: null },
  offices: [],
  totalContacts: 3,
  target: null,
};
const PIPELINE = { cycles: {} };

/**
 * The page reads its route params with `use()`, which SUSPENDS. Next supplies
 * the boundary in production; here it has to be explicit, and the render has to
 * be awaited inside `act` or the tree stays on the fallback forever.
 */
async function renderPage() {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <Suspense fallback={null}>
        <CompanyPipelinePage params={Promise.resolve({ id: "42" })} />
      </Suspense>,
    );
  });
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetListCache();
  q.fetchCompanyScopes.mockResolvedValue(SCOPES);
  q.loadPipeline.mockResolvedValue(PIPELINE);
  q.getFreshJobChangeContactIds.mockResolvedValue(new Set<number>());
});
afterEach(cleanup);

describe("company detail page cache", () => {
  it("serves the roster from cache on a remount, without re-reading it", async () => {
    const first = await renderPage();
    await waitFor(() => expect(screen.getByText("roster-ready")).toBeTruthy());
    expect(q.fetchCompanyScopes).toHaveBeenCalledTimes(1);

    // The trip into a contact and back.
    first.unmount();
    await renderPage();

    await waitFor(() => expect(screen.getByText("roster-ready")).toBeTruthy());
    expect(q.fetchCompanyScopes).toHaveBeenCalledTimes(1);
  });

  it("re-reads the pipeline on every mount, even when the roster is cached", async () => {
    const first = await renderPage();
    await waitFor(() => expect(screen.getByText("pipeline-ready")).toBeTruthy());
    expect(q.loadPipeline).toHaveBeenCalledTimes(1);

    first.unmount();
    await renderPage();

    // Not cached, on purpose: it seeds autosave state that a snapshot predates.
    await waitFor(() => expect(q.loadPipeline).toHaveBeenCalledTimes(2));
  });

  it("paints the roster before the pipeline arrives", async () => {
    // The progressive render. Without it, caching the roster buys nothing:
    // the page would still sit on "Loading…" until the pipeline landed.
    let releasePipeline: (v: unknown) => void = () => {};
    q.loadPipeline.mockReturnValue(
      new Promise((resolve) => {
        releasePipeline = resolve;
      }),
    );

    await renderPage();
    await waitFor(() => expect(screen.getByText("roster-ready")).toBeTruthy());
    expect(screen.getByText("pipeline-loading")).toBeTruthy();

    releasePipeline(PIPELINE);
    await waitFor(() => expect(screen.getByText("pipeline-ready")).toBeTruthy());
  });

  it("re-reads the roster after a write invalidates it", async () => {
    const first = await renderPage();
    await waitFor(() => expect(screen.getByText("roster-ready")).toBeTruthy());
    first.unmount();

    // What a contact edit, a tier move or a logged conversation does.
    invalidateCompanyScopes();

    await renderPage();
    await waitFor(() => expect(q.fetchCompanyScopes).toHaveBeenCalledTimes(2));
  });
});
