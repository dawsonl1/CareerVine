/**
 * Persona chip labels — one map, formerly three (CAR-213).
 *
 * `outreach/page.tsx`, `companies/person-modal.tsx`, and
 * `companies/pipeline/pipeline-layout.tsx` each carried a byte-identical copy.
 * That duplication is exactly what let the alumni framing survive the first
 * pass of this ticket: the BYU badge two lines below each map was suppressed
 * while the chip above it kept rendering "Alum · Product" on 474 of the 1,112
 * prospects a non-BYU user receives — 43% of their database labelled an alum of
 * a school they never attended.
 *
 * WHY THE LABEL DEPENDS ON THE VIEWER: `alum_product` is a pipeline fact (this
 * person is a BYU alum in a product role) and stays true regardless of who is
 * looking. What changes is whether that fact means anything to the viewer. To
 * a BYU user it is the warmest door in the product; to everyone else the person
 * is simply a PM, and calling them an "Alum" states a relationship that does
 * not exist.
 */

/** Personas whose default label leads with the alumni framing. */
const ALUM_PERSONAS = new Set(["alum_product", "alum_other"]);

const WITH_AFFINITY: Record<string, string> = {
  alum_product: "Alum · Product",
  alum_other: "Alum",
  product_peer: "Product",
  product_leader: "Product Leader",
  recruiter: "Recruiter",
};

// Same roles, minus a relationship the viewer does not have.
const WITHOUT_AFFINITY: Record<string, string> = {
  ...WITH_AFFINITY,
  alum_product: "Product",
  // alum_other never reaches a non-affinity user's database — it is exactly
  // the population the bundle filter withholds — but a contact imported by
  // hand could carry the persona, so it needs a non-alumni label too.
  alum_other: "Contact",
};

export function personaLabels(hasAffinity: boolean): Record<string, string> {
  return hasAffinity ? WITH_AFFINITY : WITHOUT_AFFINITY;
}

/** The chip text for one persona, or null when there is nothing to show. */
export function personaLabel(persona: string | null | undefined, hasAffinity: boolean): string | null {
  if (!persona) return null;
  return personaLabels(hasAffinity)[persona] ?? persona;
}

/** Exported for tests: which personas carry the alumni framing by default. */
export function isAlumPersona(persona: string | null | undefined): boolean {
  return persona != null && ALUM_PERSONAS.has(persona);
}
