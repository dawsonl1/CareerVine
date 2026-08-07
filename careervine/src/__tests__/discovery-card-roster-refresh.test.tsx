// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";

/**
 * CAR-277: adding a discovery candidate has to re-read the roster it just
 * changed.
 *
 * `act()` splices the row out of the card's OWN list and invalidates the
 * shared scopes cache, and neither of those puts the new contact on screen:
 * the roster beside this card comes from a separate read on a page that is
 * mounted right now and consults no cache again. Before this, the person you
 * had just added was simply absent, which reads as the add having failed.
 *
 * The contract asserted here is that `onAdded` fires on a SUCCESSFUL add and
 * on nothing else — not on dismiss (no contact was created) and not on a
 * failed add (there is nothing new to show, and the toast already fired).
 */

vi.mock("@/components/ui/toast", () => mockToastModule());
vi.mock("@/lib/companies-list-cache", () => ({ refreshCompaniesList: vi.fn() }));
vi.mock("@/lib/company-detail-cache", () => ({
  invalidateCompanyScopes: vi.fn(),
  COMPANY_SCOPES_TTL_MS: 60_000,
  companyScopesKey: (u: string, c: number) => `company-scopes:${u}:${c}`,
  companyScopesKeyPrefix: (u: string) => `company-scopes:${u}:`,
}));

import { mockToastModule } from "./helpers/mock-toast";
import { installFakeFetch } from "./helpers/fake-fetch";
import { refreshCompaniesList } from "@/lib/companies-list-cache";
import { DiscoveryCard } from "@/components/companies/discovery-card";

const CANDIDATE = {
  id: 11,
  company_id: 7,
  linkedin_url: "https://www.linkedin.com/in/jane",
  name: "Jane Doe",
  headline: "PM at Acme",
  location: "SLC",
  photo_url: null,
  position: "Product Manager",
};

const LIST = "GET /api/discovery/candidates?company_id=7";

/** The button a Tooltip wraps: the label is a sibling span, not a name. */
function tooltipButton(label: string): HTMLButtonElement {
  const tip = screen.getByText(label);
  return tip.parentElement!.querySelector("button") as HTMLButtonElement;
}

async function renderCard(routes: Parameters<typeof installFakeFetch>[0]) {
  const onAdded = vi.fn();
  const http = installFakeFetch({ [LIST]: { body: { candidates: [CANDIDATE] } }, ...routes });
  render(<DiscoveryCard companyId={7} onAdded={onAdded} />);
  // The card renders null until its own fetch lands.
  await waitFor(() => screen.getByText("Jane Doe"));
  return { onAdded, http };
}

describe("DiscoveryCard — the roster is re-read after an add (CAR-277)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("asks the page to reload after a successful add", async () => {
    const { onAdded, http } = await renderCard({
      "POST /api/discovery/candidates/11/add": { body: { enrich: "started" } },
    });

    await act(async () => {
      fireEvent.click(tooltipButton("Add as prospect"));
    });

    expect(onAdded).toHaveBeenCalledTimes(1);
    // And /companies, one level up (CAR-278). The new contact changes that
    // company's counts, who leads its row, and under `minContacts: 1` whether
    // the row exists at all. That list is unmounted, so it is refreshed here or
    // it serves the old numbers until its TTL expires.
    expect(refreshCompaniesList).toHaveBeenCalledTimes(1);
    expect(http.countOf("POST /api/discovery/candidates/11/add")).toBe(1);
    expect(http.unmatched).toEqual([]);
  });

  it("does not reload on dismiss, which creates no contact", async () => {
    const { onAdded, http } = await renderCard({
      "POST /api/discovery/candidates/11/dismiss": { body: {} },
    });

    await act(async () => {
      fireEvent.click(tooltipButton("Dismiss: won't be suggested again"));
    });

    expect(onAdded).not.toHaveBeenCalled();
    expect(refreshCompaniesList).not.toHaveBeenCalled();
    expect(http.countOf("POST /api/discovery/candidates/11/dismiss")).toBe(1);
    expect(http.unmatched).toEqual([]);
  });

  it("does not reload when the add fails", async () => {
    const { onAdded, http } = await renderCard({
      "POST /api/discovery/candidates/11/add": { status: 500, body: { error: "boom" } },
    });

    await act(async () => {
      fireEvent.click(tooltipButton("Add as prospect"));
    });

    expect(onAdded).not.toHaveBeenCalled();
    expect(refreshCompaniesList).not.toHaveBeenCalled();
    // The request was genuinely issued and genuinely refused — without this the
    // test would also pass if the button had simply done nothing.
    expect(http.countOf("POST /api/discovery/candidates/11/add")).toBe(1);
    expect(http.unmatched).toEqual([]);
  });
});
