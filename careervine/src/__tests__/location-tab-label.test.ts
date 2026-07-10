import { describe, expect, it } from "vitest";
import { formatOfficeTabLabel, formatRoleLocationInList } from "@/lib/location-tab-label";

describe("formatOfficeTabLabel", () => {
  it("uses US state code when state is recognized", () => {
    expect(formatOfficeTabLabel("Dallas", "Texas", "United States")).toBe("Dallas, TX");
    expect(formatOfficeTabLabel("New York", "New York", "United States")).toBe("New York, NY");
  });

  it("uses full country when state is not a US code", () => {
    expect(formatOfficeTabLabel("London", "England", "United Kingdom")).toBe("London, United Kingdom");
  });
});

describe("formatRoleLocationInList", () => {
  it("returns Remote for remote roles", () => {
    expect(formatRoleLocationInList({ workplace_type: "remote" })).toBe("Remote");
  });

  it("formats city and state code for US roles", () => {
    expect(
      formatRoleLocationInList({
        location_city: "McLean",
        location_state: "Virginia",
        location_country: "United States",
      }),
    ).toBe("McLean, VA");
  });
});
