// @vitest-environment jsdom
/**
 * Capturing the account holder's school (CAR-213, Phase 2).
 *
 * Every assertion here carries a positive control in the SAME test (plan
 * §8.2). "The school field is absent" and "no metadata key was sent" are
 * absence claims, and a render that throws or a mock that was never called
 * satisfies both of them while proving nothing.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup } from "@testing-library/react";
import { affinityTransition } from "@/lib/schools/affinity-resync";

const signUpMock = vi.fn();

vi.mock("@/lib/supabase/browser-client", () => ({
  createSupabaseBrowserClient: () => ({
    auth: {
      signUp: signUpMock,
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
      onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
    },
  }),
}));
vi.mock("@/lib/analytics/client", () => ({
  track: vi.fn(),
  identifyNewUser: vi.fn(),
  resetAnalyticsIdentity: vi.fn(),
}));

import AuthForm from "@/components/auth-form";
import { AuthProvider } from "@/components/auth-provider";

function renderSignup() {
  return render(
    <AuthProvider>
      <AuthForm initialMode="signup" />
    </AuthProvider>,
  );
}

function fillRequiredFields() {
  fireEvent.change(screen.getByPlaceholderText("First name"), { target: { value: "Dawson" } });
  fireEvent.change(screen.getByPlaceholderText("Last name"), { target: { value: "Pitcher" } });
  fireEvent.change(screen.getByPlaceholderText("Email"), { target: { value: "new@example.com" } });
  fireEvent.change(screen.getByTestId("auth-password"), { target: { value: "password123" } });
}

const typeSchool = (value: string) =>
  fireEvent.change(schoolField()!, { target: { value } });

const submit = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));
  });
};

const schoolField = () =>
  screen.queryByPlaceholderText(/Where do you go \(or did you go\) to school/i);

// The escape-hatch row renders CURLY quotes (&ldquo;/&rdquo;), so a regex with
// straight quotes silently never matches and every assertion built on it
// passes vacuously. `.` covers either character.
const ADD_ROW = (school: string) => new RegExp(`^Add .${school}.$`, "i");
const ANY_ADD_ROW = /^Add ./i;

describe("signup school field", () => {
  beforeEach(() => {
    signUpMock.mockReset();
    signUpMock.mockResolvedValue({ data: { user: { id: "u1", identities: [{}] }, session: null }, error: null });
  });

  it("is offered on signup and absent on sign in", () => {
    // Positive control first: if the field never renders at all, the sign-in
    // half of this test would pass vacuously.
    renderSignup();
    expect(schoolField()).toBeTruthy();

    cleanup();
    render(
      <AuthProvider>
        <AuthForm initialMode="signin" />
      </AuthProvider>,
    );
    expect(schoolField()).toBeNull();
  });

  it("ALWAYS sends the university key, even when left blank", async () => {
    // The migration's deploy-window grandfather distinguishes "this client
    // asked and the user declined" (key present, empty) from "this client
    // predates the question" (key absent) by testing key PRESENCE. Drop the
    // key when blank and every user who skips the field silently gets the BYU
    // experience — the exact bug CAR-213 exists to remove.
    renderSignup();
    fillRequiredFields();
    await submit();

    await waitFor(() => expect(signUpMock).toHaveBeenCalled());
    const data = signUpMock.mock.calls[0][0].options.data;
    expect(Object.keys(data)).toContain("university");
    expect(data.university).toBe("");
    expect(data.university_is_custom).toBe(false);
  });

  it("sends a curated pick as non-custom", async () => {
    renderSignup();
    fillRequiredFields();
    typeSchool("Brigham Young");
    fireEvent.click(await screen.findByRole("button", { name: "Brigham Young University" }));
    await submit();

    await waitFor(() => expect(signUpMock).toHaveBeenCalled());
    const data = signUpMock.mock.calls[0][0].options.data;
    expect(data.university).toBe("Brigham Young University");
    expect(data.university_is_custom).toBe(false);
  });

  it("sends a typed school through the escape hatch as custom", async () => {
    renderSignup();
    fillRequiredFields();
    typeSchool("Pitcher Institute of Technology");
    fireEvent.click(await screen.findByRole("button", { name: ADD_ROW("Pitcher Institute of Technology") }));
    await submit();

    await waitFor(() => expect(signUpMock).toHaveBeenCalled());
    const data = signUpMock.mock.calls[0][0].options.data;
    expect(data.university).toBe("Pitcher Institute of Technology");
    expect(data.university_is_custom).toBe(true);
  });

  it("does not offer to add a school the list already has", async () => {
    renderSignup();
    // Positive control: the escape hatch DOES appear for an unknown school...
    typeSchool("Pitcher Institute");
    expect(await screen.findByRole("button", { name: ADD_ROW("Pitcher Institute") })).toBeTruthy();

    // ...and does not for one already on the list, matched normalized so
    // casing alone cannot produce a duplicate entry.
    typeSchool("brigham young university");
    await waitFor(() => expect(screen.queryByRole("button", { name: ANY_ADD_ROW })).toBeNull());
  });
});

describe("affinityTransition — what a school edit triggers", () => {
  it("fires only when the edit CROSSES the boundary", () => {
    expect(affinityTransition("Utah State University", "Brigham Young University")).toBe("gained");
    expect(affinityTransition(null, "BYU")).toBe("gained");
    expect(affinityTransition("Brigham Young University", "Utah State University")).toBe("lost");
    expect(affinityTransition("BYU", null)).toBe("lost");
  });

  it("is a no-op for edits that stay on the same side", () => {
    // Including a switch between two different non-BYU schools, which changes
    // the badge label but nothing about which prospects the user receives.
    expect(affinityTransition("Utah State University", "Stanford University")).toBe("unchanged");
    expect(affinityTransition("Brigham Young University", "BYU-Pathway Worldwide")).toBe("unchanged");
    expect(affinityTransition(null, "")).toBe("unchanged");
    expect(affinityTransition("BYU", "Brigham Young University")).toBe("unchanged");
  });
});
