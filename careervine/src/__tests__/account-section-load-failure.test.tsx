// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import { mockAuthProviderModule } from "./helpers/mock-auth-provider";
import { mockBrowserClientModule } from "./helpers/mock-supabase";
import { mockToastModule } from "./helpers/mock-toast";

/**
 * CAR-205, finding 1: the one defect in the Wave 2 audit that DESTROYED data
 * rather than hiding it, and it predates the whole programme.
 *
 * `loadProfile` caught into `console.error` and cleared `loading` anyway, so a
 * failed read rendered the form with `firstName`/`lastName` at their initial
 * `""`. The user, seeing empty name fields, fills in or simply saves — and
 * `handleSave` writes those empty strings over the stored name in BOTH
 * `public.users` and the auth user metadata. Nothing recovers it.
 *
 * So the assertion that matters is not "an error is shown". It is that no Save
 * control exists on the failed path at all, and that `updateUserProfile` is
 * never reached with an empty name. The rest of the cases exist so this file
 * cannot pass by rendering nothing.
 */

const q = vi.hoisted(() => ({
  getUserProfile: vi.fn(),
  updateUserProfile: vi.fn(),
}));

vi.mock("@/lib/queries", () => ({
  getUserProfile: q.getUserProfile,
  updateUserProfile: q.updateUserProfile,
}));
vi.mock("@/components/auth-provider", () => mockAuthProviderModule());
vi.mock("@/components/ui/toast", () => mockToastModule());
vi.mock("@/lib/supabase/browser-client", () =>
  mockBrowserClientModule(() => ({
    auth: { updateUser: vi.fn(() => Promise.resolve({ error: null })) },
  })),
);

import AccountSection from "@/components/settings/account-section";

const profile = {
  first_name: "Ada",
  last_name: "Lovelace",
  phone: "555-0100",
  followup_nudges_enabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  q.updateUserProfile.mockResolvedValue(undefined);
});
afterEach(cleanup);

/** Mount and let the load settle, whichever way it went. */
async function renderSettled() {
  await act(async () => {
    render(<AccountSection />);
  });
  await waitFor(() => expect(screen.queryByText("Loading profile...")).toBeNull());
}

describe("AccountSection profile read failure", () => {
  it("renders the retryable error state instead of a blank form", async () => {
    q.getUserProfile.mockRejectedValue(new Error("boom"));
    await renderSettled();

    expect(screen.queryByText("Couldn't load your profile.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("offers no Save control at all while the read has failed", async () => {
    // The fix. A visible Save over blank fields is the whole defect: one click
    // and the stored name is gone.
    q.getUserProfile.mockRejectedValue(new Error("boom"));
    await renderSettled();

    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(screen.queryByPlaceholderText("First name")).toBeNull();
    expect(screen.queryByPlaceholderText("Last name")).toBeNull();
    expect(q.updateUserProfile).not.toHaveBeenCalled();
  });

  it("hides the notification toggle too, which reads the same failed row", async () => {
    // `followup_nudges_enabled` defaults to `true` in state, so leaving the
    // toggle up would show "on" to a user who had turned it off — and flipping
    // it writes that guess back.
    q.getUserProfile.mockRejectedValue(new Error("boom"));
    await renderSettled();

    expect(screen.queryByText("Follow-up reminders")).toBeNull();
  });

  it("keeps the password form, which reads nothing this loader fetched", async () => {
    // Losing an unrelated working capability because a different read failed is
    // its own regression.
    q.getUserProfile.mockRejectedValue(new Error("boom"));
    await renderSettled();

    expect(screen.queryByRole("button", { name: "Update password" })).toBeTruthy();
  });

  it("recovers on Retry, so the error state is not a dead end", async () => {
    q.getUserProfile.mockRejectedValueOnce(new Error("boom")).mockResolvedValue(profile);
    await renderSettled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });

    await waitFor(() => expect(screen.queryByText("Couldn't load your profile.")).toBeNull());
    expect((screen.getByPlaceholderText("First name") as HTMLInputElement).value).toBe("Ada");
  });

  it("still saves the real name on the success path", async () => {
    // The companion. Every assertion above is satisfied by a component that
    // renders nothing and saves nothing, so one case has to prove the happy
    // path still works.
    q.getUserProfile.mockResolvedValue(profile);
    await renderSettled();

    const form = screen.getByPlaceholderText("First name").closest("form");
    if (!form) throw new Error("profile form not found");
    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => expect(q.updateUserProfile).toHaveBeenCalledTimes(1));
    expect(q.updateUserProfile).toHaveBeenCalledWith("u-1", {
      first_name: "Ada",
      last_name: "Lovelace",
      phone: "555-0100",
    });
  });
});
