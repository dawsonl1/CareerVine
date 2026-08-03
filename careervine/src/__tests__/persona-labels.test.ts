/**
 * Persona chip labels (CAR-213).
 *
 * This file exists because a falsification probe found nothing guarding it.
 * Reverting `alum_product` to "Alum · Product" for everyone broke ZERO tests:
 * the BYU leak dragnet only greps for BYU strings, and "Alum · Product"
 * contains none. So the single largest highlighting leak in the ticket — 474 of
 * the 1,112 prospects a non-affinity user receives, 43% of their database —
 * had no coverage at all until this file.
 */

import { describe, expect, it } from "vitest";
import { isAlumPersona, personaLabel, personaLabels } from "@/lib/persona-labels";

describe("personaLabel", () => {
  it("keeps the alumni framing for a user who has alumni", () => {
    // Positive control: without this, a map that returned "Product" for
    // everything would satisfy every suppression assertion below.
    expect(personaLabel("alum_product", true)).toBe("Alum · Product");
    expect(personaLabel("alum_other", true)).toBe("Alum");
  });

  it("drops the alumni framing for everyone else", () => {
    // `alum_product` is a pipeline fact — this person IS a BYU alum in a
    // product role — and it stays true regardless of who is looking. What
    // changes is whether it means anything to the VIEWER. To a non-BYU user
    // the person is simply a PM, and "Alum" states a relationship that does
    // not exist.
    expect(personaLabel("alum_product", false)).toBe("Product");
    expect(personaLabel("alum_other", false)).toBe("Contact");
  });

  it("never renders the word Alum to a non-affinity user", () => {
    // The assertion that would have caught the leak: every label, not just
    // the two we happened to think about.
    const labels = Object.values(personaLabels(false));
    expect(labels.filter((l) => /alum/i.test(l))).toEqual([]);

    // ...and the affinity map DOES contain it, so this is not vacuous.
    expect(Object.values(personaLabels(true)).some((l) => /alum/i.test(l))).toBe(true);
  });

  it("leaves non-alumni personas identical in both maps", () => {
    // The change must be surgical: a viewer's school says nothing about
    // whether someone is a recruiter or a product leader.
    for (const persona of ["product_peer", "product_leader", "recruiter"]) {
      expect(personaLabel(persona, true)).toBe(personaLabel(persona, false));
    }
  });

  it("passes an unknown persona through unchanged rather than blanking the chip", () => {
    expect(personaLabel("some_future_persona", true)).toBe("some_future_persona");
    expect(personaLabel("some_future_persona", false)).toBe("some_future_persona");
  });

  it("renders nothing when there is no persona", () => {
    expect(personaLabel(null, true)).toBeNull();
    expect(personaLabel(undefined, false)).toBeNull();
    expect(personaLabel("", true)).toBeNull();
  });
});

describe("isAlumPersona", () => {
  it("identifies exactly the personas whose default label leads with alumni", () => {
    expect(isAlumPersona("alum_product")).toBe(true);
    expect(isAlumPersona("alum_other")).toBe(true);
    expect(isAlumPersona("product_leader")).toBe(false);
    expect(isAlumPersona("recruiter")).toBe(false);
    expect(isAlumPersona(null)).toBe(false);
  });

  it("agrees with the maps: every alum persona differs between them", () => {
    // Ties the helper to the thing it describes, so a persona added to one and
    // not the other goes red.
    const withA = personaLabels(true);
    const withoutA = personaLabels(false);
    for (const persona of Object.keys(withA)) {
      expect({ persona, differs: withA[persona] !== withoutA[persona] }).toEqual({
        persona,
        differs: isAlumPersona(persona),
      });
    }
  });
});
