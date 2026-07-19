// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";

/**
 * CAR-154 / F21: a failed contacts load must render a retryable error state,
 * not the "Your network starts here" new-user empty state.
 */

const q = vi.hoisted(() => ({
  getContactsStreamed: vi.fn(),
  createContact: vi.fn(),
  findOrCreateSchool: vi.fn(),
  addSchoolToContact: vi.fn(),
  findOrCreateCompany: vi.fn(),
  addCompanyToContact: vi.fn(),
  resolveManualCompanyLocation: vi.fn(),
  addEmailToContact: vi.fn(),
  addPhoneToContact: vi.fn(),
  getTags: vi.fn(),
  createTag: vi.fn(),
  addTagToContact: vi.fn(),
  findOrCreateLocation: vi.fn(),
  activateContact: vi.fn(),
  getNetworkTierCounts: vi.fn(),
}));

vi.mock("@/components/navigation", () => ({ __esModule: true, default: () => <nav /> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/auth-provider", () => {
  const user = { id: "u-1" };
  return { useAuth: () => ({ user }) };
});
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), toast: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/lib/company-queries", () => ({ promoteContactToProspect: vi.fn(), demoteContactToBench: vi.fn() }));
vi.mock("@/lib/analytics/client", () => ({ track: vi.fn() }));
vi.mock("@/lib/queries", () => q);

import ContactsPage from "@/app/contacts/page";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  q.getNetworkTierCounts.mockResolvedValue({ active: 0, prospect: 0, bench: 0 });
  q.getTags.mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("ContactsPage — honest load-failure state (F21)", () => {
  it("renders a retryable error state when the contacts load fails", async () => {
    q.getContactsStreamed.mockRejectedValue(new Error("rls"));

    render(<ContactsPage />);
    await waitFor(() => expect(screen.getByText("We could not load your contacts")).toBeTruthy());
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
    // Never the new-user empty state on a failed load.
    expect(screen.queryByText("Your network starts here")).toBeNull();
  });

  it("shows the empty state (not the error state) on a successful empty load", async () => {
    q.getContactsStreamed.mockResolvedValue(undefined);

    render(<ContactsPage />);
    await waitFor(() => expect(screen.getByText("Your network starts here")).toBeTruthy());
    expect(screen.queryByText("We could not load your contacts")).toBeNull();
  });
});
