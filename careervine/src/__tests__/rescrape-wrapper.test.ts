import { describe, it, expect } from "vitest";
import { actorItemToPeopleRecord } from "@/lib/apify/rescrape-wrapper";
import { mapPeopleRecord, ScrapeMappingError } from "@/lib/scrape-mapper";

const item = {
  linkedinUrl: "https://www.linkedin.com/in/jane-doe",
  firstName: "Jane",
  lastName: "Doe",
  headline: "Director of Product at Domo",
  photo: "https://media.licdn.com/x.jpg",
  location: { linkedinText: "Salt Lake City, Utah", parsed: { city: "Salt Lake City", state: "Utah", country: "United States" } },
  emails: ["jane@domo.com"],
  experience: [
    { position: "Director of Product", companyName: "Domo", companyId: "123", startDate: { month: "Mar", year: 2021 } },
  ],
  education: [],
};

describe("actorItemToPeopleRecord", () => {
  it("produces a schema-v1 record with no pipeline provenance", () => {
    const record = actorItemToPeopleRecord(item, { emailSearched: true });
    expect(record.schema_version).toBe("1");
    expect(record.identity.name).toBe("Jane Doe");
    expect(record.identity.linkedin_url).toBe("https://www.linkedin.com/in/jane-doe");
    expect(record.pipeline).toEqual({});
    expect(record.raw_profiles?.[0].source).toBe("rescrape");
  });

  it("promotes an email to 'verified' when email search ran (M5)", () => {
    const record = actorItemToPeopleRecord(item, { emailSearched: true });
    const mapped = mapPeopleRecord(record, {});
    expect(mapped.email).toEqual({ address: "jane@domo.com", source: "verified" });
  });

  it("does not attach an email when email search was not run", () => {
    const record = actorItemToPeopleRecord(item, { emailSearched: false });
    // crm.email is null; the mapper's raw-emails fallback still finds it as 'scraped'
    expect(record.crm.email).toBeNull();
    const mapped = mapPeopleRecord(record, {});
    expect(mapped.email?.source).toBe("scraped");
  });

  it("maps employment from the raw actor item", () => {
    const record = actorItemToPeopleRecord(item, { emailSearched: true });
    const mapped = mapPeopleRecord(record, {});
    expect(mapped.employment).toHaveLength(1);
    expect(mapped.employment[0]).toMatchObject({ company_name: "Domo", start_month: "Mar 2021", is_current: true });
  });

  it("builds a URL from publicIdentifier when linkedinUrl is absent", () => {
    const record = actorItemToPeopleRecord({ ...item, linkedinUrl: null, publicIdentifier: "jane-doe" }, { emailSearched: false });
    expect(record.identity.linkedin_url).toBe("https://www.linkedin.com/in/jane-doe");
  });

  it("a private/404 item (no name, no url) fails mapper validation, not silently", () => {
    const record = actorItemToPeopleRecord({ firstName: null, lastName: null, linkedinUrl: null }, { emailSearched: true });
    expect(() => mapPeopleRecord(record, {})).toThrow(ScrapeMappingError);
  });
});
