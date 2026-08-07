import { describe, it, expect } from "vitest";
import { advanceCompaniesForContacts } from "@/lib/company-stage-advance";

/**
 * CAR-239. A company target only ever left "Researching" because the user moved
 * it by hand, so Brevium sat on Researching after Lance Johnson replied and took
 * a call. These pin the two rules that keep the automation from doing harm:
 * it advances ONLY from researching, and it never moves anything backwards.
 *
 * CAR-243 adds the third: only the contact's CURRENT employer moves. Measured on
 * production, dropping that filter meant one reply from a contact with a long
 * resume advanced six companies they had already left.
 */

interface Row {
  id: number;
  company_id: number;
  user_id: string;
  status: string;
  active_cycle: number;
}

/** An employment link. is_current defaults to true so pre-CAR-243 cases read the same. */
interface Link {
  contact_id: number;
  company_id: number;
  user_id: string;
  is_current?: boolean;
}

/** Minimal PostgREST-shaped stub: records updates, filters like the real thing. */
function stub({
  targets,
  links,
}: {
  targets: Row[];
  links: Link[];
}) {
  const updates: Array<{ table: string; patch: Record<string, unknown>; filters: Record<string, unknown> }> = [];

  const builder = (table: string) => {
    const filters: Record<string, unknown> = {};
    let patch: Record<string, unknown> | null = null;
    const api: Record<string, unknown> = {};

    const settle = () => {
      if (patch) {
        updates.push({ table, patch, filters: { ...filters } });
        return { data: null, error: null };
      }
      if (table === "contact_companies") {
        const wanted = filters["in:contact_id"] as number[];
        return {
          data: links
            .filter(
              (l) =>
                wanted.includes(l.contact_id) &&
                l.user_id === filters["eq:contacts.user_id"] &&
                // Honour the filter only when the query actually sends it, so
                // dropping `.eq("is_current", true)` from the source makes the
                // former-employer tests below fail rather than silently pass.
                (!("eq:is_current" in filters) || (l.is_current ?? true) === filters["eq:is_current"]),
            )
            .map((l) => ({ company_id: l.company_id })),
          error: null,
        };
      }
      if (table === "target_companies") {
        const wanted = filters["in:company_id"] as number[];
        return {
          data: targets
            .filter(
              (t) =>
                wanted.includes(t.company_id) &&
                t.user_id === filters["eq:user_id"] &&
                t.status === filters["eq:status"],
            )
            .map((t) => ({ id: t.id, active_cycle: t.active_cycle })),
          error: null,
        };
      }
      return { data: [], error: null };
    };

    api.select = () => api;
    api.eq = (col: string, val: unknown) => {
      filters[`eq:${col}`] = val;
      return api;
    };
    api.in = (col: string, val: unknown) => {
      filters[`in:${col}`] = val;
      return api;
    };
    api.order = () => api;
    api.limit = () => api;
    api.update = (p: Record<string, unknown>) => {
      patch = p;
      return api;
    };
    // Awaiting the builder runs the query.
    api.then = (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve);
    return api;
  };

  return { client: { from: builder }, updates };
}

const USER = "user-1";

describe("advanceCompaniesForContacts", () => {
  it("moves a Researching company to Active outreach", async () => {
    const { client, updates } = stub({
      targets: [{ id: 10, company_id: 100, user_id: USER, status: "researching", active_cycle: 1 }],
      links: [{ contact_id: 1, company_id: 100, user_id: USER }],
    });

    const result = await advanceCompaniesForContacts(client, USER, [1]);

    expect(result.advanced).toEqual([10]);
    const targetUpdate = updates.find((u) => u.table === "target_companies");
    expect(targetUpdate?.patch).toEqual({ status: "outreach_active" });
    // Re-asserts researching in the WHERE so a concurrent manual move survives.
    expect(targetUpdate?.filters["eq:status"]).toBe("researching");
  });

  it("mirrors the stage onto the active cycle so both surfaces agree", async () => {
    const { client, updates } = stub({
      targets: [{ id: 10, company_id: 100, user_id: USER, status: "researching", active_cycle: 3 }],
      links: [{ contact_id: 1, company_id: 100, user_id: USER }],
    });

    await advanceCompaniesForContacts(client, USER, [1]);

    const cycleUpdate = updates.find((u) => u.table === "pipeline_cycles");
    expect(cycleUpdate?.patch).toEqual({ selected_stage: "outreach_active" });
    expect(cycleUpdate?.filters["eq:cycle_number"]).toBe(3);
    expect(cycleUpdate?.filters["eq:selected_stage"]).toBe("researching");
  });

  it("NEVER drags a company backwards from a later stage", async () => {
    for (const status of ["outreach_active", "applied", "interviewing", "closed"]) {
      const { client, updates } = stub({
        targets: [{ id: 10, company_id: 100, user_id: USER, status, active_cycle: 1 }],
        links: [{ contact_id: 1, company_id: 100, user_id: USER }],
      });

      const result = await advanceCompaniesForContacts(client, USER, [1]);

      expect(result.advanced, `status ${status} must not advance`).toEqual([]);
      expect(updates, `status ${status} must write nothing`).toEqual([]);
    }
  });

  it("does not touch another user's target for the same company", async () => {
    const { client, updates } = stub({
      targets: [{ id: 99, company_id: 100, user_id: "someone-else", status: "researching", active_cycle: 1 }],
      links: [{ contact_id: 1, company_id: 100, user_id: USER }],
    });

    const result = await advanceCompaniesForContacts(client, USER, [1]);
    expect(result.advanced).toEqual([]);
    expect(updates).toEqual([]);
  });

  it("no-ops on an empty contact list without querying", async () => {
    const { client, updates } = stub({ targets: [], links: [] });
    expect(await advanceCompaniesForContacts(client, USER, [])).toEqual({ advanced: [] });
    expect(updates).toEqual([]);
  });

  it("no-ops when the contact has no company", async () => {
    const { client, updates } = stub({
      targets: [{ id: 10, company_id: 100, user_id: USER, status: "researching", active_cycle: 1 }],
      links: [],
    });
    expect(await advanceCompaniesForContacts(client, USER, [7])).toEqual({ advanced: [] });
    expect(updates).toEqual([]);
  });

  it("NEVER advances a company the contact has already left (CAR-243)", async () => {
    const { client, updates } = stub({
      targets: [{ id: 10, company_id: 100, user_id: USER, status: "researching", active_cycle: 1 }],
      links: [{ contact_id: 1, company_id: 100, user_id: USER, is_current: false }],
    });

    const result = await advanceCompaniesForContacts(client, USER, [1]);

    expect(result.advanced).toEqual([]);
    expect(updates).toEqual([]);
  });

  it("advances only the current employer when the contact has both (CAR-243)", async () => {
    const { client } = stub({
      targets: [
        { id: 10, company_id: 100, user_id: USER, status: "researching", active_cycle: 1 },
        { id: 11, company_id: 101, user_id: USER, status: "researching", active_cycle: 1 },
      ],
      links: [
        { contact_id: 1, company_id: 100, user_id: USER, is_current: true },
        { contact_id: 1, company_id: 101, user_id: USER, is_current: false },
      ],
    });

    const result = await advanceCompaniesForContacts(client, USER, [1]);

    expect(result.advanced).toEqual([10]);
  });

  it("dedupes repeated contact ids", async () => {
    const { client } = stub({
      targets: [{ id: 10, company_id: 100, user_id: USER, status: "researching", active_cycle: 1 }],
      links: [{ contact_id: 1, company_id: 100, user_id: USER }],
    });
    const result = await advanceCompaniesForContacts(client, USER, [1, 1, 1]);
    expect(result.advanced).toEqual([10]);
  });
});
