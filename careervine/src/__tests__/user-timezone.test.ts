/**
 * CAR-215: the server-side zone resolution order.
 *
 * The ordering is the whole point. `gmail_connections.calendar_timezone` used
 * to be the only stored zone AND carried a DEFAULT of America/New_York, so it
 * confidently reported Eastern for users who had never been near it. It is now
 * the weakest signal, behind the live request header and the stamped
 * users.timezone, and behind all of them is UTC rather than a regional guess.
 */
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveUserTimeZone } from "@/lib/user-timezone";
import { TIMEZONE_HEADER } from "@/lib/timezone";

/**
 * Minimal stub of the two single-row reads the resolver makes.
 * `throwOn` simulates a database that is refusing reads.
 */
function stubService(opts: {
  userTimezone?: string | null;
  calendarTimezone?: string | null;
  throwOn?: "users" | "gmail_connections";
}): { service: SupabaseClient; tablesRead: string[] } {
  const tablesRead: string[] = [];
  const service = {
    from(table: string) {
      tablesRead.push(table);
      if (opts.throwOn === table) throw new Error("read refused");
      const row =
        table === "users"
          ? { timezone: opts.userTimezone ?? null }
          : { calendar_timezone: opts.calendarTimezone ?? null };
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: row, error: null }),
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  return { service, tablesRead };
}

const headersWith = (zone: string) => new Headers({ [TIMEZONE_HEADER]: zone });

describe("resolveUserTimeZone", () => {
  it("prefers the request header, without touching the database", async () => {
    const { service, tablesRead } = stubService({ userTimezone: "America/New_York" });
    await expect(resolveUserTimeZone(service, "u1", headersWith("America/Denver")))
      .resolves.toBe("America/Denver");
    expect(tablesRead).toEqual([]);
  });

  it("falls back to the stamped users.timezone when there is no header", async () => {
    const { service } = stubService({ userTimezone: "America/Los_Angeles" });
    await expect(resolveUserTimeZone(service, "u1")).resolves.toBe("America/Los_Angeles");
  });

  it("falls back to the calendar zone only when nothing better exists", async () => {
    const { service, tablesRead } = stubService({
      userTimezone: null,
      calendarTimezone: "Europe/London",
    });
    await expect(resolveUserTimeZone(service, "u1")).resolves.toBe("Europe/London");
    expect(tablesRead).toEqual(["users", "gmail_connections"]);
  });

  it("returns UTC, never a regional guess, when nothing is known", async () => {
    const { service } = stubService({ userTimezone: null, calendarTimezone: null });
    await expect(resolveUserTimeZone(service, "u1")).resolves.toBe("UTC");
  });

  it("ignores a junk header rather than trusting it", async () => {
    // The header is attacker-controlled and the result is fed to Intl.
    const { service } = stubService({ userTimezone: "America/Denver" });
    await expect(resolveUserTimeZone(service, "u1", headersWith("Mars/Olympus_Mons")))
      .resolves.toBe("America/Denver");
  });

  it("ignores a junk stored value too", async () => {
    const { service } = stubService({
      userTimezone: "not a zone",
      calendarTimezone: "America/Denver",
    });
    await expect(resolveUserTimeZone(service, "u1")).resolves.toBe("America/Denver");
  });

  it("degrades to UTC instead of throwing when the database read fails", async () => {
    // Scheduling must not break because a lookup did.
    const { service } = stubService({ throwOn: "users" });
    await expect(resolveUserTimeZone(service, "u1")).resolves.toBe("UTC");
  });

  it("still honours the header when the database is unreachable", async () => {
    const { service } = stubService({ throwOn: "users" });
    await expect(resolveUserTimeZone(service, "u1", headersWith("Asia/Tokyo")))
      .resolves.toBe("Asia/Tokyo");
  });
});
