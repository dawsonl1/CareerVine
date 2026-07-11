import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the browser client factory; each test wires its own query behavior.
const mockMaybeSingle = vi.fn();
const mockUpdateResult = vi.fn();

vi.mock("@/lib/supabase/browser-client", () => ({
  createSupabaseBrowserClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: mockMaybeSingle }),
      }),
      update: (_payload: unknown, _opts?: unknown) => ({
        eq: () => ({
          eq: () => mockUpdateResult(),
        }),
      }),
    }),
  }),
}));

import {
  getExtensionOnboardingSnapshot,
  advanceExtensionOnboardingState,
} from "@/lib/onboarding/extension-state";

function row(state: string, contactId: number | null = null, lastSeen: string | null = null) {
  return {
    data: {
      extension_onboarding_state: state,
      extension_onboarding_contact_id: contactId,
      extension_last_seen_at: lastSeen,
    },
    error: null,
  };
}

beforeEach(() => {
  mockMaybeSingle.mockReset();
  mockUpdateResult.mockReset();
});

describe("getExtensionOnboardingSnapshot error handling (CAR-68 deep-review fix)", () => {
  it("returns the snapshot on a successful read", async () => {
    mockMaybeSingle.mockResolvedValue(row("awaiting_connect", null, "2026-07-11T00:00:00Z"));
    const snap = await getExtensionOnboardingSnapshot("u1");
    expect(snap).toEqual({
      state: "awaiting_connect",
      contactId: null,
      extensionLastSeenAt: "2026-07-11T00:00:00Z",
    });
  });

  it("returns null — never a fabricated state — on a read error", async () => {
    // The original fail-closed-to-"done" behavior let one transient poll
    // error falsely complete the whole flow.
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: "network blip" } });
    expect(await getExtensionOnboardingSnapshot("u1")).toBeNull();
  });

  it("returns null when the row is missing", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getExtensionOnboardingSnapshot("u1")).toBeNull();
  });
});

describe("advanceExtensionOnboardingState CAS (CAR-68 deep-review fix)", () => {
  it("advances and returns next when the CAS matches a row", async () => {
    mockMaybeSingle.mockResolvedValue(row("not_started"));
    mockUpdateResult.mockResolvedValue({ error: null, count: 1 });
    expect(await advanceExtensionOnboardingState("u1", "started")).toBe("started");
  });

  it("returns null and writes nothing when the current state can't be read", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect(await advanceExtensionOnboardingState("u1", "started")).toBeNull();
    expect(mockUpdateResult).not.toHaveBeenCalled();
  });

  it("re-reads and reports the fresh state when the CAS loses the race (count 0)", async () => {
    // Read says awaiting_first_contact, but the server advanced to email_offer
    // between the read and the write — the CAS matches zero rows.
    mockMaybeSingle
      .mockResolvedValueOnce(row("awaiting_first_contact"))
      .mockResolvedValueOnce(row("email_offer", 42));
    mockUpdateResult.mockResolvedValue({ error: null, count: 0 });
    expect(await advanceExtensionOnboardingState("u1", "email_offer")).toBe("email_offer");
    expect(mockMaybeSingle).toHaveBeenCalledTimes(2);
  });

  it("does not write backward transitions", async () => {
    mockMaybeSingle.mockResolvedValue(row("email_offer"));
    expect(await advanceExtensionOnboardingState("u1", "awaiting_connect")).toBe("email_offer");
    expect(mockUpdateResult).not.toHaveBeenCalled();
  });

  it("returns the current state when the update itself errors", async () => {
    mockMaybeSingle.mockResolvedValue(row("started"));
    mockUpdateResult.mockResolvedValue({ error: { message: "denied" }, count: null });
    expect(await advanceExtensionOnboardingState("u1", "awaiting_connect")).toBe("started");
  });
});
