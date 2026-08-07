// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import { mockAuthProviderModule } from "./helpers/mock-auth-provider";
import type { CompanyDetail, CompanySummary } from "@/lib/company-queries";

/**
 * CAR-190: the outreach page's company detail fetch was identity-keyed on the
 * company and gated on nothing.
 *
 * ←/→ and the jump Select both change `company` and refire the load, and
 * getCompanyDetail runs three sequential waves that scale with employee count,
 * so the latency spread between two in-flight companies is structural. Ungated,
 * the slower response won last: the page rendered one company's header over
 * another's employees, and clicking a person there opened a compose prefilled
 * to someone at the other company.
 *
 * Two separate defects, so two separate tests. The gate stops the stale
 * response committing; clearing `detail` on company change stops the previous
 * company's people rendering under the new header for the whole fetch, which
 * happened on every navigation after the first because the render gate is
 * `detailLoading && !detail`.
 */

const q = vi.hoisted(() => ({
  getCompanies: vi.fn(),
  getCompanyDetail: vi.fn(),
}));

const nav = vi.hoisted(() => ({
  params: new URLSearchParams(),
  replace: vi.fn(),
}));

vi.mock("@/lib/company-queries", () => ({
  getCompanies: q.getCompanies,
  getCompanyDetail: q.getCompanyDetail,
}));
vi.mock("@/components/auth-provider", () => mockAuthProviderModule());
vi.mock("@/components/navigation", () => ({ __esModule: true, default: () => <nav /> }));
/**
 * Real state rather than a frozen `isOpen: false`, so a test can open and close
 * the composer and drive the page's compose-close refresh effect — the caller
 * that CAR-205's regression lives on. `isOpen` stays false unless a test moves
 * it, so every case written against the old constant mock is unaffected.
 */
const compose = vi.hoisted(() => ({ setOpen: null as null | ((v: boolean) => void) }));
vi.mock("@/components/compose-email-context", async () => {
  const React = await import("react");
  return {
    useCompose: () => {
      const [isOpen, setIsOpen] = React.useState(false);
      compose.setOpen = setIsOpen;
      return { openCompose: () => {}, isOpen };
    },
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace }),
  useSearchParams: () => nav.params,
}));

import OutreachPage from "@/app/outreach/page";

function summary(id: number, name: string): CompanySummary {
  return {
    id,
    name,
    logo_url: null,
    linkedin_url: null,
    current_count: 1,
    former_count: 0,
    bench_count: 0,
    alum_count: 0,
    product_alum_count: 0,
    recruiter_count: 0,
    lead_contact_name: null,
    target: { status: "open" } as CompanySummary["target"],
    office_scopes: [],
    traction: null,
    traction_detail: null,
    lead_detail: null,
    conversation: null,
  };
}

function detail(id: number, name: string, personName: string): CompanyDetail {
  return {
    company: { id, name, logo_url: null, linkedin_url: null, universal_name: null },
    target: null,
    offices: [],
    facets: [],
    current: [
      {
        contact_id: id * 100,
        name: personName,
        photo_url: null,
        headline: null,
        persona: null,
        network_status: "active",
        is_alum: false,
        review_note: null,
        selection_reason: null,
        last_scraped_at: null,
        linkedin_url: null,
        stage: null,
        email: { address: `${personName}@x.com`, source: "verified", bounced: false },
        last_interaction: null,
        adjacency_score: null,
        roles: [],
      } as unknown as CompanyDetail["current"][number],
    ],
    former: [],
    bench: [],
  };
}

/** A getCompanyDetail whose responses resolve only when the test says so. */
function deferredDetails() {
  const pending = new Map<number, (d: CompanyDetail) => void>();
  q.getCompanyDetail.mockImplementation(
    (_userId: string, companyId: number) =>
      new Promise<CompanyDetail>((resolve) => pending.set(companyId, resolve)),
  );
  return pending;
}

beforeEach(() => {
  nav.params = new URLSearchParams();
  nav.replace.mockImplementation((url: string) => {
    nav.params = new URLSearchParams(url.split("?")[1] ?? "");
  });
  q.getCompanies.mockResolvedValue([summary(1, "Acme"), summary(2, "Globex")]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("outreach company detail race (CAR-190)", () => {
  it("a slower earlier company's people never overwrite the newer company's", async () => {
    const pending = deferredDetails();
    const view = render(<OutreachPage />);

    // Company A's request goes out and stays in flight — this is the one that
    // must lose. getCompanyDetail runs three waves scaling with employee count,
    // so a big first company genuinely does resolve after a small second one.
    await waitFor(() => expect(pending.has(1)).toBe(true));

    // Navigate to company B before A has answered. The page re-reads
    // searchParams on render, so the mocked replace() is followed by a rerender.
    await act(async () => {
      fireEvent.click(screen.getByTitle("Next company (→)"));
    });
    await act(async () => {
      view.rerender(<OutreachPage />);
    });
    await waitFor(() => expect(pending.has(2)).toBe(true));

    // B answers first...
    await act(async () => pending.get(2)!(detail(2, "Globex", "Bob")));
    await waitFor(() => expect(screen.getByText("Bob")).toBeTruthy());

    // ...then A's slower response lands. It must not commit: A's person under
    // B's header is the bug, and clicking it composed to the wrong company.
    await act(async () => pending.get(1)!(detail(1, "Acme", "Alice")));

    expect(screen.queryByText("Alice")).toBeNull();
    expect(screen.getByText("Bob")).toBeTruthy();
  });

  it("renders a retryable error state when the detail load fails, not a blank", async () => {
    // Clearing `detail` on every company change (the test below) means a
    // failed load leaves nothing to render, and the gate's final arm is
    // `null`. A company header over empty space reads as "nobody here is
    // contactable", which in an outreach queue is the one conclusion a 500
    // must not produce. Section f: a failed load gets the retryable state.
    q.getCompanyDetail.mockRejectedValue(new Error("boom"));
    render(<OutreachPage />);

    await waitFor(() => expect(screen.getByText(/Couldn't load the people/)).toBeTruthy());
    // Not the load-empty copy, which is an affirmative claim about the data.
    expect(screen.queryByText("Nobody contactable here yet.")).toBeNull();

    // And the retry actually re-reads.
    q.getCompanyDetail.mockResolvedValue(detail(1, "Acme", "Alice"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    await waitFor(() => expect(screen.getByText("Alice")).toBeTruthy());
  });

  /**
   * CAR-205. CAR-190 added `detailFailed` and put its render branch AHEAD of the
   * `detail` branch, which is right for the company-change path (that effect
   * clears `detail` first, so there is nothing to preserve) and wrong for the
   * compose-close path, which refires `loadDetail()` over a populated list.
   *
   * Driven through the composer rather than through the Retry button, because
   * Retry is only reachable from the error state — the exact case that already
   * has no `detail` to lose.
   */
  async function closeComposerOver(view: ReturnType<typeof render>) {
    await act(async () => compose.setOpen!(true));
    await act(async () => {
      view.rerender(<OutreachPage />);
    });
    await act(async () => compose.setOpen!(false));
    await act(async () => {
      view.rerender(<OutreachPage />);
    });
  }

  it("keeps the people on screen when a compose-close refresh fails", async () => {
    q.getCompanyDetail.mockResolvedValue(detail(1, "Acme", "Alice"));
    const view = render(<OutreachPage />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeTruthy());

    // The refresh that follows the composer closing now fails.
    q.getCompanyDetail.mockRejectedValue(new Error("boom"));
    await closeComposerOver(view);

    // The people were loaded, are still valid, and are what the user came for.
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.queryByText(/Couldn't load the people/)).toBeNull();
  });

  it("says so, rather than showing the stale list silently", async () => {
    // The other half. Section f only lets a refresh stay quiet when it follows
    // a FAILED write; this one follows a send, so the failure has to surface —
    // as the inline banner, which is the documented shape for a partial failure
    // beside content worth keeping.
    q.getCompanyDetail.mockResolvedValue(detail(1, "Acme", "Alice"));
    const view = render(<OutreachPage />);
    await waitFor(() => expect(screen.getByText("Alice")).toBeTruthy());

    q.getCompanyDetail.mockRejectedValue(new Error("boom"));
    await closeComposerOver(view);

    expect(screen.getByText(/Couldn't refresh this company's people/)).toBeTruthy();

    // And its Retry clears the banner rather than being decoration.
    q.getCompanyDetail.mockResolvedValue(detail(1, "Acme", "Alice"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    await waitFor(() =>
      expect(screen.queryByText(/Couldn't refresh this company's people/)).toBeNull(),
    );
    expect(screen.getByText("Alice")).toBeTruthy();
  });

  it("treats a null detail resolve as a failure rather than an empty company", async () => {
    // getCompanyDetail returns CompanyDetail | null; a null reaches the same
    // empty render as a throw and must take the same retryable state.
    q.getCompanyDetail.mockResolvedValue(null);
    render(<OutreachPage />);

    await waitFor(() => expect(screen.getByText(/Couldn't load the people/)).toBeTruthy());
  });

  it("clears the previous company's people while the new company loads", async () => {
    const pending = deferredDetails();
    const view = render(<OutreachPage />);

    await waitFor(() => expect(pending.has(1)).toBe(true));
    await act(async () => pending.get(1)!(detail(1, "Acme", "Alice")));
    await waitFor(() => expect(screen.getByText("Alice")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTitle("Next company (→)"));
    });
    await act(async () => {
      view.rerender(<OutreachPage />);
    });
    await waitFor(() => expect(pending.has(2)).toBe(true));

    // Mid-flight, with B's header already on screen: Alice must be gone. The
    // gate is `detailLoading && !detail`, so a retained `detail` rendered the
    // old people for the whole fetch on every navigation after the first.
    expect(screen.queryByText("Alice")).toBeNull();
    expect(screen.getByText("Loading people…")).toBeTruthy();
  });
});
