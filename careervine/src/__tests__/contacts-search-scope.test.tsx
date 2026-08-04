// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import { mockAuthProviderModule } from "./helpers/mock-auth-provider";
import { mockToastModule } from "./helpers/mock-toast";
import { mockAnalyticsClientModule } from "./helpers/mock-analytics";
import type { ContactListItem } from "@/lib/types";

/**
 * Reproduction of the contacts search bugs Dawson reported (2026-08-04), sized
 * to his real data: 9 active, 1140 prospects, 856 bench.
 */

const q = vi.hoisted(() => ({
  getContactsStreamed: vi.fn(),
  getNetworkTierCounts: vi.fn(),
  getTags: vi.fn(),
}));

vi.mock("@/lib/queries", () => ({
  getContactsStreamed: q.getContactsStreamed,
  getNetworkTierCounts: q.getNetworkTierCounts,
  getTags: q.getTags,
  createContact: vi.fn(),
  findOrCreateSchool: vi.fn(),
  addSchoolToContact: vi.fn(),
  findOrCreateCompany: vi.fn(),
  addCompanyToContact: vi.fn(),
  resolveManualCompanyLocation: vi.fn(),
  addEmailToContact: vi.fn(),
  addPhoneToContact: vi.fn(),
  createTag: vi.fn(),
  addTagToContact: vi.fn(),
  findOrCreateLocation: vi.fn(),
  activateContact: vi.fn(),
}));
vi.mock("@/lib/company-queries", () => ({
  promoteContactToProspect: vi.fn(),
  demoteContactToBench: vi.fn(),
}));
vi.mock("@/lib/analytics/client", () => mockAnalyticsClientModule());
vi.mock("@/components/auth-provider", () => mockAuthProviderModule());
vi.mock("@/components/ui/toast", () => mockToastModule());
vi.mock("@/components/navigation", () => ({ __esModule: true, default: () => <nav /> }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import ContactsPage from "@/app/contacts/page";

let nextId = 1;
function contact(
  name: string,
  network_status: "active" | "prospect" | "bench",
  extra: Partial<ContactListItem> = {},
): ContactListItem {
  return {
    id: nextId++,
    name,
    network_status,
    user_id: "u-1",
    photo_url: null,
    industry: null,
    contact_emails: [],
    contact_phones: [],
    contact_companies: [],
    contact_schools: [],
    contact_tags: [],
    ...extra,
  } as unknown as ContactListItem;
}

/** Dawson's real tier shape, scaled down but with the same asymmetry. */
function buildNetwork() {
  nextId = 1;
  const active = [
    contact("Bryant Allred", "active"),
    contact("Amy Chen", "active"),
    contact("Zack Turner", "active"),
  ];
  const prospect = [
    contact("Ryan Allred", "prospect"),
    contact("Priya Nair", "prospect"),
  ];
  const bench = [contact("Bryant Searle", "bench")];
  return { active, prospect, bench };
}

function mockStream(net: ReturnType<typeof buildNetwork>) {
  q.getContactsStreamed.mockImplementation(
    async (
      _userId: string,
      statuses: Array<"active" | "prospect" | "bench">,
      onPage: (rows: ContactListItem[]) => void,
    ) => {
      const rows = statuses.flatMap((s) => net[s]);
      if (rows.length) onPage(rows);
      return rows;
    },
  );
  q.getNetworkTierCounts.mockResolvedValue({
    active: net.active.length,
    prospect: net.prospect.length,
    bench: net.bench.length,
  });
  q.getTags.mockResolvedValue([]);
}

async function renderPage() {
  render(<ContactsPage />);
  // Chips only render once tier counts prove prospects/archive exist.
  await waitFor(() => expect(screen.getByRole("button", { name: /Prospects/ })).toBeTruthy());
}

function searchBox() {
  return screen.getByPlaceholderText("Search contacts…");
}

async function type(value: string) {
  await act(async () => {
    fireEvent.change(searchBox(), { target: { value } });
  });
}

/**
 * Names rendered in the contact list. The card name is the only `h3` on the
 * page while the create-contact modal is closed, so this reads the list itself
 * rather than the suggestions dropdown (which renders `p` elements).
 */
function listedNames(): string[] {
  return screen
    .queryAllByRole("heading", { level: 3 })
    .map((el) => el.textContent ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStream(buildNetwork());
});
afterEach(cleanup);

describe("contacts search scope", () => {
  it("finds a prospect by name without toggling the Prospects chip first", async () => {
    await renderPage();
    await type("Priya");

    // Priya is a prospect; the default view is the active network only.
    await waitFor(() => expect(listedNames()).toContain("Priya Nair"));
  });

  it("finds an archived contact by name from the default view", async () => {
    await renderPage();
    await type("Bryant Searle");

    await waitFor(() => expect(listedNames()).toContain("Bryant Searle"));
  });

  it("refreshes results when a tier chip is toggled with a query already typed", async () => {
    // Honest caveat: this passed BEFORE the fix too. The reported freeze came
    // from useDeferredValue starving a ~1,149-card render, and at six rows in
    // jsdom the deferred render commits inside the first waitFor. Kept as a
    // guard that a toggle repaints at all, not as a reproduction of the freeze
    // -- the render cap is what actually removes that cost.
    await renderPage();
    await type("Allred");

    expect(listedNames()).toContain("Bryant Allred");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Prospects/ }));
    });

    await waitFor(() => expect(listedNames()).toContain("Ryan Allred"));
  });

  it("matches a full name typed with surrounding whitespace", async () => {
    await renderPage();
    await type("  Bryant Allred  ");

    await waitFor(() => expect(listedNames()).toContain("Bryant Allred"));
  });

  it("matches name tokens out of order and across extra spaces", async () => {
    await renderPage();
    await type("allred bryant");

    await waitFor(() => expect(listedNames()).toContain("Bryant Allred"));
  });

  it("ranks the exact name match above a same-token company match", async () => {
    // "Aaron Reed" deliberately sorts BEFORE "Bryant Allred": the list arrives
    // in name order, so an unranked result set would put the company match
    // first and this assertion would pass vacuously if it were the other way
    // round.
    const net = buildNetwork();
    net.active.push(
      contact("Aaron Reed", "active", {
        contact_companies: [
          { title: "Analyst", companies: { id: 1, name: "Allred Partners" } },
        ],
      } as Partial<ContactListItem>),
    );
    mockStream(net);

    await renderPage();
    await type("allred");

    await waitFor(() => expect(listedNames().length).toBeGreaterThan(1));
    expect(listedNames()[0]).toBe("Bryant Allred");
  });

  it("still honours the tier chips when there is no query", async () => {
    // The chips remain a browse filter; only SEARCH ignores them.
    await renderPage();

    expect(listedNames()).toContain("Bryant Allred");
    expect(listedNames()).not.toContain("Priya Nair");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Prospects/ }));
    });

    await waitFor(() => expect(listedNames()).toContain("Priya Nair"));
  });

  it("says so when nothing matches, rather than leaving a blank page", async () => {
    await renderPage();
    await type("nobody-by-this-name");

    await waitFor(() => expect(screen.getByText("No contacts match your search.")).toBeTruthy());
    expect(listedNames()).toEqual([]);
  });

  it("says nothing matches on an empty account too, instead of a blank page", async () => {
    // A brand new user has no contacts at all, so there are no tier chips and
    // `contacts` stays empty. The tier empty states are suppressed under a
    // query, which leaves this message as the only thing on the page: without
    // it, typing renders nothing whatsoever.
    mockStream({ active: [], prospect: [], bench: [] });
    render(<ContactsPage />);
    await waitFor(() => expect(screen.getByPlaceholderText("Search contacts…")).toBeTruthy());
    await type("zzz");

    await waitFor(() => expect(screen.getByText("No contacts match your search.")).toBeTruthy());
  });

  it("says the search spans the whole network so off-tier hits read correctly", async () => {
    await renderPage();
    expect(screen.queryByText(/Searching your whole network/)).toBeNull();

    await type("Priya");
    await waitFor(() => expect(screen.getByText(/Searching your whole network/)).toBeTruthy());
  });
});

describe("contacts list render cap", () => {
  /** 150 prospects, so the 100-row cap bites. */
  function bigNetwork() {
    const net = buildNetwork();
    for (let i = 0; i < 150; i++) {
      net.prospect.push(contact(`Prospect ${String(i).padStart(3, "0")}`, "prospect"));
    }
    return net;
  }

  it("caps the rendered rows and reveals the rest on request", async () => {
    const net = bigNetwork();
    mockStream(net);
    await renderPage();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Prospects/ }));
    });

    const total = net.active.length + net.prospect.length;
    await waitFor(() => expect(listedNames().length).toBe(100));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: `Show all ${total}` }));
    });
    await waitFor(() => expect(listedNames().length).toBe(total));
  });

  it("re-caps after a new query, rather than carrying 'show all' forward", async () => {
    mockStream(bigNetwork());
    await renderPage();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Prospects/ }));
    });
    await waitFor(() => expect(listedNames().length).toBe(100));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Show all / }));
    });
    await waitFor(() => expect(listedNames().length).toBeGreaterThan(100));

    await type("Prospect");
    await waitFor(() => expect(listedNames().length).toBe(100));
  });

  it("shows no 'Show all' control when everything already fits", async () => {
    await renderPage();
    expect(screen.queryByRole("button", { name: /^Show all / })).toBeNull();
  });
});
