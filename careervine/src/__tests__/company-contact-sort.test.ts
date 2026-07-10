import { describe, expect, it } from "vitest";
import { byAlumThenPersona } from "@/lib/company-queries";

type P = { name: string; persona: string | null; is_alum: boolean };
const p = (name: string, persona: string | null, is_alum = false): P => ({ name, persona, is_alum });

describe("byAlumThenPersona (company page contacts order, CAR-55)", () => {
  it("puts BYU alumni above non-alumni regardless of persona rank", () => {
    const sorted = [
      p("Rachel Recruiter", "recruiter"),
      p("Larry Leader", "product_leader"),
      p("Oscar Other", "alum_other", true),
      p("Nina Nopersona", null, true),
    ].sort(byAlumThenPersona);
    expect(sorted.map((x) => x.name)).toEqual([
      "Oscar Other",
      "Nina Nopersona",
      "Rachel Recruiter",
      "Larry Leader",
    ]);
  });

  it("keeps persona rank order within alumni and within non-alumni", () => {
    const sorted = [
      p("Alum Peer", "product_peer", true),
      p("Alum Recruiter", "recruiter", true),
      p("Plain Peer", "product_peer"),
      p("Plain Recruiter", "recruiter"),
    ].sort(byAlumThenPersona);
    expect(sorted.map((x) => x.name)).toEqual([
      "Alum Recruiter",
      "Alum Peer",
      "Plain Recruiter",
      "Plain Peer",
    ]);
  });

  it("ties break by name, with unknown personas last within their alum group", () => {
    const sorted = [
      p("Zoe", "recruiter"),
      p("Abe", "recruiter"),
      p("Mystery", "something_new"),
      p("Nobody", null),
    ].sort(byAlumThenPersona);
    expect(sorted.map((x) => x.name)).toEqual(["Abe", "Zoe", "Mystery", "Nobody"]);
  });
});
