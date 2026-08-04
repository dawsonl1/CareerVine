import { describe, it, expect } from "vitest";
import {
  normalizeSearchText,
  parseSearchTokens,
  matchesSearch,
  searchContacts,
  type SearchableContact,
} from "@/lib/contact-search";

function person(
  name: string,
  extra: Partial<SearchableContact> = {},
): SearchableContact {
  return { name, ...extra };
}

const withCompany = (name: string, company: string, title = "") =>
  person(name, { contact_companies: [{ title, companies: { name: company } }] });

const withTag = (name: string, tag: string) =>
  person(name, { contact_tags: [{ tags: { name: tag } }] });

describe("normalizeSearchText", () => {
  it("lowercases, folds diacritics, and collapses whitespace", () => {
    expect(normalizeSearchText("  José   MUÑOZ  ")).toBe("jose munoz");
  });

  it("leaves an all-whitespace string empty", () => {
    expect(normalizeSearchText("   \n\t ")).toBe("");
  });
});

describe("parseSearchTokens", () => {
  it("splits on any run of whitespace", () => {
    expect(parseSearchTokens(" Bryant \t Allred ")).toEqual(["bryant", "allred"]);
  });

  it("returns no tokens for a blank query", () => {
    expect(parseSearchTokens("  ")).toEqual([]);
  });
});

describe("matchesSearch", () => {
  const bryant = withCompany("Bryant Allred", "R1 RCM", "Senior Product Manager");

  it("matches a full name typed with surrounding whitespace", () => {
    expect(matchesSearch(bryant, "  Bryant Allred  ")).toBe(true);
  });

  it("matches tokens in either order", () => {
    expect(matchesSearch(bryant, "allred bryant")).toBe(true);
  });

  it("matches a query whose spacing differs from the stored name", () => {
    expect(matchesSearch(person("Bryant  Allred"), "bryant allred")).toBe(true);
  });

  it("matches across fields, one token per field", () => {
    expect(matchesSearch(bryant, "bryant r1")).toBe(true);
  });

  it("requires every token to hit something", () => {
    expect(matchesSearch(bryant, "bryant lawyer")).toBe(false);
  });

  it("matches an unaccented query against an accented name", () => {
    expect(matchesSearch(person("José Muñoz"), "jose munoz")).toBe(true);
  });

  it("treats a blank query as matching everything", () => {
    expect(matchesSearch(bryant, "   ")).toBe(true);
  });

  it("does not match on a substring the contact never contains", () => {
    expect(matchesSearch(bryant, "zzz")).toBe(false);
  });
});

describe("searchContacts ranking", () => {
  it("ranks a name match above a tag match", () => {
    const rows = [withTag("Priya Nair", "allred-referral"), person("Bryant Allred")];
    expect(searchContacts(rows, "allred").map((r) => r.name)).toEqual([
      "Bryant Allred",
      "Priya Nair",
    ]);
  });

  it("ranks a name match above a company match", () => {
    const rows = [withCompany("Dana Reed", "Allred Partners"), person("Bryant Allred")];
    expect(searchContacts(rows, "allred")[0]!.name).toBe("Bryant Allred");
  });

  it("ranks a word-start hit above a mid-string hit", () => {
    const rows = [person("Kim Ballard"), person("Sam Allred")];
    expect(searchContacts(rows, "all")[0]!.name).toBe("Sam Allred");
  });

  it("ranks an exact full-name match above a partial one", () => {
    const rows = [person("Bryant Allred Jr"), person("Bryant Allred")];
    expect(searchContacts(rows, "bryant allred")[0]!.name).toBe("Bryant Allred");
  });

  it("drops non-matches entirely", () => {
    const rows = [person("Bryant Allred"), person("Priya Nair")];
    expect(searchContacts(rows, "allred").map((r) => r.name)).toEqual(["Bryant Allred"]);
  });

  it("breaks score ties alphabetically, not by input order", () => {
    const rows = [person("Zoe Allred"), person("Amy Allred")];
    expect(searchContacts(rows, "allred").map((r) => r.name)).toEqual([
      "Amy Allred",
      "Zoe Allred",
    ]);
  });

  it("returns the input untouched for a blank query", () => {
    const rows = [person("Zoe Allred"), person("Amy Allred")];
    expect(searchContacts(rows, "  ")).toBe(rows);
  });

  it("searches emails and schools too", () => {
    const rows = [
      person("Bryant Allred", { contact_emails: [{ email: "ballred@r1rcm.com" }] }),
      person("Priya Nair", { contact_schools: [{ schools: { name: "Brigham Young University" } }] }),
    ];
    expect(searchContacts(rows, "r1rcm")[0]!.name).toBe("Bryant Allred");
    expect(searchContacts(rows, "brigham")[0]!.name).toBe("Priya Nair");
  });

  it("tolerates rows with null joins and a null name", () => {
    const rows: SearchableContact[] = [
      { name: null },
      { name: "Bryant Allred", contact_emails: null, contact_companies: null },
    ];
    expect(searchContacts(rows, "allred").map((r) => r.name)).toEqual(["Bryant Allred"]);
  });
});
