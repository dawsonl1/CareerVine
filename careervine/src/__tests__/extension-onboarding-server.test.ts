import { describe, it, expect, vi } from "vitest";
import { advanceExtensionOnboarding } from "@/lib/onboarding/extension-server";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Chainable supabase mock: records update payloads/filters, resolves reads
 * from a canned state. Every builder method returns the chain; awaiting it
 * resolves like PostgREST does.
 */
function mockSupabase(state: string | null) {
  const updates: { payload: Record<string, unknown>; filters: Record<string, unknown>[] }[] = [];
  function chain(kind: "select" | "update", payload?: Record<string, unknown>) {
    const filters: Record<string, unknown>[] = [];
    const c = {
      eq: (col: string, val: unknown) => { filters.push({ op: "eq", col, val }); return c; },
      in: (col: string, val: unknown) => { filters.push({ op: "in", col, val }); return c; },
      maybeSingle: () =>
        Promise.resolve(
          state === null
            ? { data: null, error: null }
            : { data: { extension_onboarding_state: state }, error: null },
        ),
      then: (resolve: (v: { error: null }) => void) => {
        if (kind === "update") updates.push({ payload: payload!, filters });
        return Promise.resolve({ error: null }).then(resolve);
      },
    };
    return c;
  }
  const supabase = {
    from: () => ({
      select: () => chain("select"),
      update: (payload: Record<string, unknown>) => chain("update", payload),
    }),
  } as unknown as SupabaseClient;
  return { supabase, updates };
}

describe("advanceExtensionOnboarding (CAR-68 import-route hook)", () => {
  it.each(["started", "awaiting_connect", "awaiting_first_contact"])(
    "advances %s → email_offer and records the contact id",
    async (state) => {
      const { supabase, updates } = mockSupabase(state);
      await advanceExtensionOnboarding(supabase, "u1", 42, false);
      expect(updates).toHaveLength(1);
      expect(updates[0].payload).toEqual({
        extension_onboarding_state: "email_offer",
        extension_onboarding_contact_id: 42,
      });
    },
  );

  it("advances awaiting_email_contact → done only when the import has an email", async () => {
    const withEmail = mockSupabase("awaiting_email_contact");
    await advanceExtensionOnboarding(withEmail.supabase, "u1", 42, true);
    expect(withEmail.updates).toHaveLength(1);
    expect(withEmail.updates[0].payload).toEqual({ extension_onboarding_state: "done" });

    const withoutEmail = mockSupabase("awaiting_email_contact");
    await advanceExtensionOnboarding(withoutEmail.supabase, "u1", 42, false);
    expect(withoutEmail.updates).toHaveLength(0);
  });

  it.each(["not_started", "email_offer", "apollo_intro", "apollo_install", "apollo_howto", "done", "completed_no_apollo"])(
    "does not advance from %s",
    async (state) => {
      const { supabase, updates } = mockSupabase(state);
      await advanceExtensionOnboarding(supabase, "u1", 42, true);
      expect(updates).toHaveLength(0);
    },
  );

  it("guards the first-contact update with a CAS state filter", async () => {
    const { supabase, updates } = mockSupabase("awaiting_first_contact");
    await advanceExtensionOnboarding(supabase, "u1", 42, false);
    const casFilter = updates[0].filters.find((f) => f.op === "in");
    expect(casFilter).toMatchObject({
      col: "extension_onboarding_state",
      val: ["started", "awaiting_connect", "awaiting_first_contact"],
    });
  });

  it("swallows read errors instead of throwing into the import", async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.reject(new Error("boom")) }),
        }),
      }),
    } as unknown as SupabaseClient;
    await expect(advanceExtensionOnboarding(supabase, "u1", 42, true)).resolves.toBeUndefined();
  });

  it("does nothing when the user row is missing", async () => {
    const { supabase, updates } = mockSupabase(null);
    await advanceExtensionOnboarding(supabase, "u1", 42, true);
    expect(updates).toHaveLength(0);
  });
});
