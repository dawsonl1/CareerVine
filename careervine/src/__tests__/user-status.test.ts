import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { filterActiveUserIds } from "@/lib/user-status";

function mockService(result: { data: unknown; error: { message: string } | null }) {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    select: () => builder,
    in: () => builder,
    eq: () => builder,
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
  });
  return { from: () => builder } as unknown as SupabaseClient;
}

describe("filterActiveUserIds", () => {
  it("returns only the ids the query reports as active", async () => {
    const service = mockService({ data: [{ id: "a" }, { id: "c" }], error: null });
    const active = await filterActiveUserIds(service, ["a", "b", "c"]);
    expect(active).toEqual(new Set(["a", "c"]));
  });

  it("short-circuits on an empty input without querying", async () => {
    const from = vi.fn();
    const service = { from } as unknown as SupabaseClient;
    const active = await filterActiveUserIds(service, []);
    expect(active.size).toBe(0);
    expect(from).not.toHaveBeenCalled();
  });

  it("fails open (treats all as active) when the query errors", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const service = mockService({ data: null, error: { message: "boom" } });
    const active = await filterActiveUserIds(service, ["a", "b"]);
    expect(active).toEqual(new Set(["a", "b"]));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
