import { describe, it, expect, expectTypeOf } from "vitest";
import { z } from "zod";
import {
  profileDataSchema,
  extensionImportSchema,
  parseProfileJsonSchema,
} from "@/lib/extension-contract";
// Kept as a dedicated `import type` line so the exit-criteria grep still finds
// exactly one declaration site (the shared contract module itself).
import type { ProfileData } from "@/lib/extension-contract";

// CAR-148 (F11) — the import wire used to be `z.record(z.string(), z.unknown())`
// (validated nothing). These tests pin the real validation, the schema/type
// parity, and the parse-profile → import correspondence.

describe("profileDataSchema — real wire validation", () => {
  it("accepts an empty profile and fills the post-parse defaults", () => {
    const r = profileDataSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.experience).toEqual([]);
      expect(r.data.education).toEqual([]);
      expect(r.data.suggested_tags).toEqual([]);
      expect(r.data.location).toEqual({});
      expect(r.data.contact_status).toBeNull();
    }
  });

  it("rejects a malformed profile — experience must be an array", () => {
    expect(profileDataSchema.safeParse({ experience: "nope" }).success).toBe(false);
  });

  it("rejects location sent as a scalar instead of an object", () => {
    expect(profileDataSchema.safeParse({ location: "USA" }).success).toBe(false);
  });

  it("rejects a non-object profile entirely", () => {
    expect(profileDataSchema.safeParse(123).success).toBe(false);
    expect(profileDataSchema.safeParse(null).success).toBe(false);
    expect(profileDataSchema.safeParse("x").success).toBe(false);
  });

  it("rejects a malformed nested experience row (is_current must be boolean)", () => {
    expect(
      profileDataSchema.safeParse({ experience: [{ company: "Acme", is_current: "yes" }] }).success,
    ).toBe(false);
  });

  it("tolerates unknown/legacy keys (strips, never rejects) for backward-compat", () => {
    const r = profileDataSchema.safeParse({ name: "Jane", somethingOldExtensionsSent: 1 });
    expect(r.success).toBe(true);
    if (r.success) expect("somethingOldExtensionsSent" in r.data).toBe(false);
  });
});

describe("extensionImportSchema — the full import body", () => {
  it("accepts a valid body with photoUrl", () => {
    const r = extensionImportSchema.safeParse({
      profileData: { name: "Jane", experience: [{ company: "Acme", title: "Eng" }] },
      photoUrl: "https://example.com/p.jpg",
    });
    expect(r.success).toBe(true);
  });

  it("propagates profileData validation — a malformed profile fails the body", () => {
    expect(extensionImportSchema.safeParse({ profileData: { experience: "x" } }).success).toBe(false);
  });

  it("rejects a non-URL photoUrl", () => {
    expect(extensionImportSchema.safeParse({ profileData: {}, photoUrl: "not a url" }).success).toBe(false);
  });
});

describe("schema/type parity", () => {
  it("the inferred output type equals the shared ProfileData (compile-time)", () => {
    expectTypeOf<z.infer<typeof profileDataSchema>>().toEqualTypeOf<ProfileData>();
  });
});

describe("parse-profile JSON schema ⊆ import wire", () => {
  const topProps = Object.keys(parseProfileJsonSchema.schema.properties);
  const contractFields = Object.keys(profileDataSchema.shape);

  it("every top-level AI-output property is a known profile field", () => {
    for (const p of topProps) {
      expect(contractFields).toContain(p);
    }
  });

  it("an AI-parse-shaped profile validates against the import wire (parse feeds import)", () => {
    // Mirrors parseProfileJsonSchema's output exactly, incl. every experience &
    // education item field — so parse output flows into import without loss.
    const sample = {
      first_name: "Jane",
      last_name: "Doe",
      location: { city: "SF", state: "CA", country: "United States" },
      industry: "Tech",
      generated_notes: "Two short sentences about the person.",
      suggested_tags: ["mentor", "alumni"],
      experience: [
        { company: "Acme", title: "Engineer", location: "SF, CA", start_month: "Jan 2020", end_month: "Present" },
      ],
      education: [
        { school: "MIT", degree: "Bachelor's", field_of_study: "CS", start_year: "2016", end_year: "2020" },
      ],
    };
    const r = profileDataSchema.safeParse(sample);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.first_name).toBe("Jane");
      expect(r.data.experience[0].company).toBe("Acme");
      expect(r.data.experience[0].start_month).toBe("Jan 2020");
      expect(r.data.education[0].school).toBe("MIT");
      expect(r.data.education[0].field_of_study).toBe("CS");
    }
  });
});
