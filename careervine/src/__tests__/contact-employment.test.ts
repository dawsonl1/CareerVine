import { describe, it, expect, vi } from "vitest";
import {
  loadContactEmploymentMap,
  resolveEmailsToContactIds,
} from "@/lib/contact-employment";

function mockService(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  return {
    from: (table: string) => {
      const state: Record<string, unknown> = { table };
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in"]) {
        chain[m] = (...args: unknown[]) => {
          state[m] = args;
          return chain;
        };
      }
      // Make the chain thenable so `await service.from(...).select()...` works.
      chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        try {
          return Promise.resolve(handlers[table]?.(state) ?? { data: [], error: null }).then(resolve, reject);
        } catch (e) {
          return Promise.reject(e).then(resolve, reject);
        }
      };
      return chain;
    },
  };
}

describe("contact-employment", () => {
  it("resolveEmailsToContactIds lowercases and maps to contact ids", async () => {
    const service = mockService({
      contact_emails: () => ({
        data: [{ email: "Jane@Corp.com", contact_id: 5 }],
        error: null,
      }),
    });
    const map = await resolveEmailsToContactIds(service, "u-1", ["JANE@corp.com", "", null]);
    expect(map.get("jane@corp.com")).toBe(5);
  });

  it("loadContactEmploymentMap fills title, company, and office", async () => {
    const service = mockService({
      contacts: () => ({
        data: [{ id: 5, name: "Jane Doe" }],
        error: null,
      }),
      contact_companies: () => ({
        data: [
          {
            contact_id: 5,
            title: "PM",
            location: null,
            workplace_type: "hybrid",
            locations: { city: "SF", state: "CA", country: "US" },
            companies: { id: 9, name: "Acme" },
          },
        ],
        error: null,
      }),
    });
    const map = await loadContactEmploymentMap(service, "u-1", [5]);
    expect(map[5]).toEqual({
      id: 5,
      name: "Jane Doe",
      title: "PM",
      company_id: 9,
      company_name: "Acme",
      location_label: "SF, CA",
    });
  });

  it("uses Remote when workplace_type is remote and no office", async () => {
    const service = mockService({
      contacts: () => ({
        data: [{ id: 2, name: "Bob" }],
        error: null,
      }),
      contact_companies: () => ({
        data: [
          {
            contact_id: 2,
            title: "Engineer",
            location: null,
            workplace_type: "remote",
            locations: null,
            companies: { id: 1, name: "Co" },
          },
        ],
        error: null,
      }),
    });
    const map = await loadContactEmploymentMap(service, "u-1", [2]);
    expect(map[2].location_label).toBe("Remote");
  });
});
