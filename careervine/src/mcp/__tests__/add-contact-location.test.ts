import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * add_contact (createContactFull) must canonicalize a US state to its full name
 * before find-or-creating the location, so an agent passing "CA" lands on the
 * same `locations` row as "California" — the canonical form the web dropdown
 * (CAR-114) and the scrape/import pipeline store. findOrCreateLocation matches
 * on exact state equality, so a mismatch silently duplicates the location.
 *
 * Uses the shared recording client (CAR-151) — the same harness the scoping
 * gate drives — so the `locations` lookup's filters are observable.
 */

const state = vi.hoisted(() => ({
  recorded: [] as unknown[],
  route: (() => undefined) as (q: unknown) => unknown,
  nextId: 100,
}));

vi.mock("@/lib/supabase/service-client", async () => {
  const { createRecordingClient } = await import("./helpers/recording-client");
  return {
    createSupabaseServiceClient: () =>
      createRecordingClient(state as Parameters<typeof createRecordingClient>[0]),
  };
});
vi.mock("@/lib/analytics/server", () => ({
  trackServer: async () => {},
  checkContactMilestone: async () => {},
}));

import { initDb, createContactFull } from "../lib/db";
import type { RecordedQuery, RouteCtx } from "./helpers/recording-client";

const USER = "user-1";

/** state passed to the `locations` lookup for the given add_contact location. */
async function stateWrittenFor(location: { city?: string; state?: string; country: string }): Promise<unknown> {
  state.recorded.length = 0; // isolate this call (a test may make several)
  state.nextId = 100;
  state.route = (q) => {
    const ctx = q as RouteCtx;
    // Location lookup resolves to an existing row so the flow stops there.
    if (ctx.table === "locations" && ctx.resolution === "maybeSingle") return { id: 1 };
    return undefined;
  };
  await createContactFull({ name: "Test", location });
  const loc = (state.recorded as RecordedQuery[]).find((r) => r.table === "locations");
  const stateFilter = loc?.filters.find(([, col]) => col === "state");
  return stateFilter?.[2];
}

beforeEach(() => {
  state.recorded.length = 0;
  state.route = () => undefined;
  state.nextId = 100;
  initDb(USER);
});

describe("add_contact location state normalization", () => {
  it("canonicalizes a US 2-letter state to the full name", async () => {
    expect(await stateWrittenFor({ city: "San Francisco", state: "CA", country: "United States" }))
      .toBe("California");
  });

  it("canonicalizes lowercase / full-name US states to the canonical full name", async () => {
    expect(await stateWrittenFor({ city: "Austin", state: "texas", country: "United States" }))
      .toBe("Texas");
    expect(await stateWrittenFor({ city: "New York", state: "New York", country: "United States" }))
      .toBe("New York");
  });

  it("treats US aliases (USA) as the United States", async () => {
    expect(await stateWrittenFor({ city: "Seattle", state: "wa", country: "USA" }))
      .toBe("Washington");
  });

  it("falls back to the raw value for an unrecognized US state", async () => {
    expect(await stateWrittenFor({ city: "Metropolis", state: "Freedonia", country: "United States" }))
      .toBe("Freedonia");
  });

  it("leaves a non-US state untouched", async () => {
    expect(await stateWrittenFor({ city: "Toronto", state: "ON", country: "Canada" }))
      .toBe("ON");
  });
});
