// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import { mockAuthProviderModule } from "./helpers/mock-auth-provider";
import { mockBrowserClientModule } from "./helpers/mock-supabase";
import { mockToastModule } from "./helpers/mock-toast";

/**
 * CAR-205, finding 1, and it predates the whole programme.
 *
 * `loadProfile` caught into `console.error` and cleared `loading` anyway, so a
 * failed read rendered the profile form with `firstName`/`lastName` at their
 * initial `""` and Save live, as though the user had no name on file.
 *
 * What that costs, stated accurately (the first version of this docblock said
 * "one click and the stored name is gone", which the CAR-205 review disproved):
 * both name inputs are `required` and the form is not `noValidate`, so a click
 * on Save over blank fields is refused by constraint validation. The reachable
 * loss is the step after — the user, believing the fields really are empty,
 * retypes a name to satisfy `required` and saves, overwriting the stored name
 * with a guess and writing `phone: null` over a stored phone, which has no
 * `required` to protect it.
 *
 * So the assertion that matters is that no Save control exists on the failed
 * path at all, in either the settled state or the retry window. The rest of the
 * cases exist so this file cannot pass by rendering nothing.
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

  it("shows the spinner, not the writable form, while a Retry is in flight", async () => {
    // CAR-205 review. `loadProfile` cleared `loadFailed` before its await and
    // never re-raised `loading`, so clicking Retry dropped straight back to the
    // form with the name fields still unloaded and Save live, for the whole
    // length of the read. The settled-state test below cannot see this: it
    // resolves the retry inside the same act(), so the window never renders.
    let releaseRetry: (v: unknown) => void = () => {};
    q.getUserProfile
      .mockRejectedValueOnce(new Error("boom"))
      .mockImplementationOnce(() => new Promise((res) => { releaseRetry = res; }));
    await renderSettled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });

    expect(screen.queryByText("Loading profile...")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(screen.queryByText("Follow-up reminders")).toBeNull();

    await act(async () => {
      releaseRetry(profile);
    });
    expect((screen.getByPlaceholderText("First name") as HTMLInputElement).value).toBe("Ada");
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
