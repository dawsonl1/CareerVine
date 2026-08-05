// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import { mockAuthProviderModule } from "./helpers/mock-auth-provider";
import { mockToastModule } from "./helpers/mock-toast";
import { mockAnalyticsClientModule } from "./helpers/mock-analytics";
import type { ContactListItem } from "@/lib/types";

/**
 * The /contacts loading contract after CAR-229.
 *
 * Before: every tier streamed to exhaustion on mount, because the tier chips
 * AND search were both client-side filters over one in-memory superset — ~2,005
 * rows with their nested joins, 14.8s cold on Dawson's account.
 *
 * After: mount streams the ACTIVE tier only; prospect and bench stream when
 * their chip is switched on; and search reads a separate lean all-tiers corpus
 * fetched once, on the first search interaction.
 *
 * The load-bearing test here is "finds a contact in a tier that was never
 * toggled on and never streamed" — that is CAR-222's requirement, and the one
 * this change could plausibly have broken. It is written so it CANNOT pass
 * vacuously: the stream mock only ever returns the tiers it was asked for, and
 * the assertions state outright that bench was never streamed.
 */

const q = vi.hoisted(() => ({
  getContactsStreamed: vi.fn(),
  getNetworkTierCounts: vi.fn(),
  getTags: vi.fn(),
}));

const corpus = vi.hoisted(() => ({ getContactsSearchCorpus: vi.fn() }));

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
vi.mock("@/lib/data/contacts", () => ({
  getContactsSearchCorpus: corpus.getContactsSearchCorpus,
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

type Tier = "active" | "prospect" | "bench";

let nextId = 1;
function contact(name: string, network_status: Tier): ContactListItem {
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
  } as unknown as ContactListItem;
}

/**
 * Dawson's asymmetry in miniature: a handful of active contacts and a large
 * prospect/archive population the chips keep out of the default view.
 */
function buildNetwork() {
  nextId = 1;
  return {
    active: [contact("Amy Chen", "active"), contact("Zack Turner", "active")],
    prospect: [contact("Priya Nair", "prospect"), contact("Ravi Menon", "prospect")],
    bench: [contact("Bryant Searle", "bench")],
  };
}

/** The tiers each getContactsStreamed call was asked for, in call order. */
function streamedTiers(): Tier[][] {
  return q.getContactsStreamed.mock.calls.map((c) => c[1] as Tier[]);
}

function mockStream(net: ReturnType<typeof buildNetwork>) {
  // Answers ONLY for the tiers requested: a tier the page never asks for
  // contributes no rows to `contacts`, which is what makes the
  // "never streamed" assertions below non-vacuous.
  q.getContactsStreamed.mockImplementation(
    async (_userId: string, statuses: Tier[], onPage: (rows: ContactListItem[]) => void) => {
      const rows = statuses.flatMap((s) => net[s]);
      if (rows.length) onPage(rows);
      return rows;
    },
  );
  // Head counts know the whole account even when nothing is loaded.
  q.getNetworkTierCounts.mockResolvedValue({
    active: net.active.length,
    prospect: net.prospect.length,
    bench: net.bench.length,
  });
  q.getTags.mockResolvedValue([]);
  corpus.getContactsSearchCorpus.mockResolvedValue([
    ...net.active,
    ...net.prospect,
    ...net.bench,
  ]);
}

async function renderPage() {
  render(<ContactsPage />);
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

function listedNames(): string[] {
  return screen.queryAllByRole("heading", { level: 3 }).map((el) => el.textContent ?? "");
}

function chip(label: RegExp) {
  return screen.getByRole("button", { name: label });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStream(buildNetwork());
});
afterEach(cleanup);

describe("contacts mount load (CAR-229)", () => {
  it("streams only the active tier on mount", async () => {
    await renderPage();

    expect(streamedTiers()).toEqual([["active"]]);
    // The default view is the active network, and nothing else was fetched.
    expect(listedNames()).toEqual(["Amy Chen", "Zack Turner"]);
  });

  it("does not fetch the search corpus on mount", async () => {
    await renderPage();
    expect(corpus.getContactsSearchCorpus).not.toHaveBeenCalled();
  });

  it("streams a tier the first time its chip is switched on, and keeps it in memory", async () => {
    await renderPage();

    await act(async () => { fireEvent.click(chip(/Prospects/)); });
    await waitFor(() => expect(listedNames()).toContain("Priya Nair"));
    expect(streamedTiers()).toEqual([["active"], ["prospect"]]);

    // Off and on again: the rows are already in memory, so no second fetch.
    await act(async () => { fireEvent.click(chip(/Prospects/)); });
    await act(async () => { fireEvent.click(chip(/Prospects/)); });
    await waitFor(() => expect(listedNames()).toContain("Priya Nair"));
    expect(streamedTiers()).toEqual([["active"], ["prospect"]]);
    // The archive was never asked for at any point.
    expect(streamedTiers().flat()).not.toContain("bench");
  });
});

describe("whole-network search over the lean corpus (CAR-222 regression guard)", () => {
  it("finds a contact whose tier is neither toggled on nor loaded", async () => {
    await renderPage();

    // Preconditions, stated so a later change cannot make this vacuous: the
    // archive chip is off, and the archive was never streamed — so "Bryant
    // Searle" exists nowhere in the page's loaded contacts.
    expect(chip(/Archive/).getAttribute("aria-pressed")).toBe("false");
    expect(streamedTiers().flat()).not.toContain("bench");
    expect(listedNames()).not.toContain("Bryant Searle");

    await type("Bryant Searle");

    await waitFor(() => expect(listedNames()).toContain("Bryant Searle"));
    // Found through the corpus, not by quietly loading the tier behind it.
    expect(streamedTiers().flat()).not.toContain("bench");
    expect(corpus.getContactsSearchCorpus).toHaveBeenCalledTimes(1);
  });

  it("fetches the corpus once per session, however much is typed", async () => {
    await renderPage();

    await type("P");
    await type("Pri");
    await type("Priya");
    await waitFor(() => expect(listedNames()).toContain("Priya Nair"));

    // Refocusing must not re-fetch either.
    await act(async () => { fireEvent.focus(searchBox()); });
    expect(corpus.getContactsSearchCorpus).toHaveBeenCalledTimes(1);
  });

  it("starts the corpus fetch on focus, before anything is typed", async () => {
    await renderPage();

    await act(async () => { fireEvent.focus(searchBox()); });
    expect(corpus.getContactsSearchCorpus).toHaveBeenCalledTimes(1);
    // Focus alone is not a query: the list still shows the active network.
    expect(listedNames()).toEqual(["Amy Chen", "Zack Turner"]);
  });

  it("keeps searching the loaded tiers when the corpus fetch fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    corpus.getContactsSearchCorpus.mockRejectedValue(new Error("offline"));
    await renderPage();

    await type("Amy");
    await waitFor(() => expect(listedNames()).toContain("Amy Chen"));
    // And says the results may be incomplete rather than claiming completeness.
    expect(screen.getByText(/Still loading, so more matches may appear/)).toBeTruthy();
  });

  it("promotes a search hit from an unloaded tier and keeps it on screen", async () => {
    await renderPage();
    await type("Bryant Searle");
    await waitFor(() => expect(listedNames()).toContain("Bryant Searle"));

    // The collapsed card's tier buttons are icon-only (their Tooltip label is
    // not an accessible name), so go through the expanded preview's labelled
    // "Add to network" button instead.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Quick preview" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Add to network/ }));
    });

    // Clearing the query drops back to the active view, which must now include
    // him: the row was never in `contacts`, so a naive in-place update would
    // have lost him entirely.
    await type("");
    await waitFor(() => expect(listedNames()).toContain("Bryant Searle"));
  });
});

describe("tier chip counts (CAR-229)", () => {
  it("reports an unloaded tier from the head-count RPC, and a loaded one from its rows", async () => {
    const net = buildNetwork();
    // The RPC knows about far more prospects than this session will ever load.
    mockStream(net);
    q.getNetworkTierCounts.mockResolvedValue({ active: 2, prospect: 1140, bench: 856 });

    await renderPage();
    // Nothing but active is in memory, so both numbers come from the RPC.
    await waitFor(() => expect(chip(/Prospects/).textContent).toContain("1140"));
    expect(chip(/Archive/).textContent).toContain("856");

    // Once a tier has finished streaming, its own rows are the truth — that is
    // the only case where a derived count is still valid.
    await act(async () => { fireEvent.click(chip(/Prospects/)); });
    await waitFor(() => expect(chip(/Prospects/).textContent).toContain("2"));
    expect(chip(/Prospects/).textContent).not.toContain("1140");
    // The archive, still unloaded, still reads from the RPC.
    expect(chip(/Archive/).textContent).toContain("856");
  });

  it("shows the toggles from the RPC alone, before any non-active tier loads", async () => {
    await renderPage();

    expect(chip(/Prospects/)).toBeTruthy();
    expect(chip(/Archive/)).toBeTruthy();
    expect(streamedTiers()).toEqual([["active"]]);
  });
});
