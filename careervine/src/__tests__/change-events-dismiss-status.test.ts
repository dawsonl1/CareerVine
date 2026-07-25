/**
 * CAR-188 — `markChangeEventStatus` must not report success on a failed write.
 *
 * It ran the update and ignored the result. supabase-js RESOLVES with
 * `{ error }` rather than throwing, so a refused write walked straight out of
 * the function and both callers (`/api/change-events/dismiss` and
 * `/api/suggestions/save`) answered `200 {success:true}`.
 *
 * That is what made the client-side half of this ticket load-bearing in the
 * other direction too: `use-suggestions.ts` now checks the response, but a
 * check against a server that always says ok proves nothing. The dismissed
 * card would come back on the next load with no error anywhere in the stack.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase/service-client", () => mockServiceClientModule());

import { mockServiceClientModule } from "./helpers/mock-supabase";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { markChangeEventStatus } from "@/lib/change-events/change-events";
import { ChangeEventStatus } from "@/lib/constants";

interface QueryState {
  table: string;
  payload?: unknown;
  filters: Array<{ method: string; args: unknown[] }>;
}

/** Minimal update-only builder: this function issues exactly one query. */
function createMockClient(result: { error: { message: string } | null }) {
  const calls: QueryState[] = [];
  const client = {
    from(table: string) {
      const state: QueryState = { table, filters: [] };
      calls.push(state);
      const builder: Record<string, unknown> = {};
      Object.assign(builder, {
        update(payload: unknown) {
          state.payload = payload;
          return builder;
        },
        eq(...args: unknown[]) {
          state.filters.push({ method: "eq", args });
          return builder;
        },
        then(onFulfilled: (v: unknown) => unknown) {
          return Promise.resolve({ data: null, error: result.error }).then(onFulfilled);
        },
      });
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

const serviceClientMock = vi.mocked(createSupabaseServiceClient);

beforeEach(() => vi.clearAllMocks());

describe("markChangeEventStatus (CAR-188)", () => {
  it("throws when the update fails, so the route cannot answer 200", async () => {
    const { client } = createMockClient({ error: { message: "permission denied" } });
    serviceClientMock.mockReturnValue(client as unknown as ReturnType<typeof createSupabaseServiceClient>);

    await expect(
      markChangeEventStatus(42, "user-1", ChangeEventStatus.Dismissed),
    ).rejects.toMatchObject({ message: "permission denied" });
  });

  it("resolves on a successful write, scoped to the row AND its owner", async () => {
    const { client, calls } = createMockClient({ error: null });
    serviceClientMock.mockReturnValue(client as unknown as ReturnType<typeof createSupabaseServiceClient>);

    await expect(
      markChangeEventStatus(42, "user-1", ChangeEventStatus.Dismissed),
    ).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("contact_change_events");
    // The service client bypasses RLS, so the user_id filter is the only thing
    // keeping one tenant from dismissing another's change event.
    expect(calls[0].filters).toEqual([
      { method: "eq", args: ["id", 42] },
      { method: "eq", args: ["user_id", "user-1"] },
    ]);
    expect(calls[0].payload).toEqual({ status: ChangeEventStatus.Dismissed });
  });

  it("stamps actioned_at only on the actioned transition", async () => {
    const { client, calls } = createMockClient({ error: null });
    serviceClientMock.mockReturnValue(client as unknown as ReturnType<typeof createSupabaseServiceClient>);

    await markChangeEventStatus(42, "user-1", ChangeEventStatus.Actioned);

    const payload = calls[0].payload as { status: string; actioned_at?: string };
    expect(payload.status).toBe(ChangeEventStatus.Actioned);
    expect(typeof payload.actioned_at).toBe("string");
  });
});
