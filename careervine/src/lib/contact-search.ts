/**
 * Contact search matching and ranking (CAR-222).
 *
 * One matcher, shared by the contacts page and the MCP `search_contacts` tool,
 * because both surfaces had independently grown the same
 * `field.toLowerCase().includes(query)` check and inherited the same three
 * defects:
 *
 *   - `"  Bryant Allred  "` missed, because the raw query (not the trimmed one)
 *     was the needle.
 *   - `"allred bryant"` missed, because the whole query had to appear as one
 *     contiguous run. So did a query typed with one space against a name stored
 *     with two, which LinkedIn-scraped rows do have.
 *   - Results kept their load order, so a tag match could sit above an exact
 *     name match.
 *
 * The model here is: normalize both sides, split the query into tokens, and
 * require EVERY token to hit SOME field. That is what makes multi-word queries
 * behave the way people expect ("bryant r1" finds Bryant Allred at R1 RCM)
 * without a contiguity constraint that a trailing space can break.
 *
 * Ranking is per-token best-field: each token scores the strongest field it hit,
 * and the contact's score is the sum. Field weights are ordered by how strongly
 * the field identifies a person — a name hit is worth more than a tag hit — and
 * a token that starts a word beats one buried mid-string, so "all" ranks
 * "Allred" above "Ballard".
 */

/**
 * Lowercase, strip diacritics, collapse runs of whitespace.
 *
 * Diacritic folding matters because names arrive from LinkedIn with their real
 * accents ("José Muñoz") while people search from a US keyboard without them.
 * NFD splits a letter into base + combining mark, so dropping the U+0300–U+036F
 * block leaves the base letter behind.
 */
export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Query tokens, normalized. Empty when the query is blank. */
export function parseSearchTokens(query: string): string[] {
  const normalized = normalizeSearchText(query);
  return normalized ? normalized.split(" ") : [];
}

/**
 * Weight per field, highest first. These are the ranking, so their ORDER is the
 * meaningful part: name identifies a person outright, an email nearly so, then
 * where they work, then where they studied, then the loose buckets.
 */
const FIELD_WEIGHT = {
  name: 100,
  email: 60,
  company: 40,
  title: 30,
  headline: 20,
  school: 20,
  industry: 10,
  tag: 10,
} as const;

type FieldKind = keyof typeof FIELD_WEIGHT;

/** A contact reduced to the text worth searching, with each field's kind. */
export type SearchableFields = Array<{ kind: FieldKind; text: string }>;

/**
 * The row shape the matcher needs. Deliberately structural and all-optional on
 * the joins: the web page's `ContactListItem` and the MCP's `SearchRow` are
 * different types with different select shapes, and this is the overlap. Both
 * satisfy it without a cast.
 */
export type SearchableContact = {
  name: string | null;
  industry?: string | null;
  headline?: string | null;
  contact_emails?: Array<{ email: string | null }> | null;
  contact_companies?: Array<{
    title?: string | null;
    companies?: { name?: string | null } | null;
  }> | null;
  contact_schools?: Array<{ schools?: { name?: string | null } | null }> | null;
  contact_tags?: Array<{ tags?: { name?: string | null } | null }> | null;
};

/** Flatten a contact into normalized, kind-tagged text. */
export function searchableFields(contact: SearchableContact): SearchableFields {
  const fields: SearchableFields = [];
  const push = (kind: FieldKind, text: string | null | undefined) => {
    if (!text) return;
    const normalized = normalizeSearchText(text);
    if (normalized) fields.push({ kind, text: normalized });
  };

  push("name", contact.name);
  push("industry", contact.industry);
  push("headline", contact.headline);
  for (const e of contact.contact_emails ?? []) push("email", e.email);
  for (const cc of contact.contact_companies ?? []) {
    push("company", cc.companies?.name);
    push("title", cc.title);
  }
  for (const cs of contact.contact_schools ?? []) push("school", cs.schools?.name);
  for (const ct of contact.contact_tags ?? []) push("tag", ct.tags?.name);

  return fields;
}

/**
 * How well one token scores against one field, or 0 for no hit.
 *
 * A word-boundary hit is worth double a mid-string hit, and covering the whole
 * field adds a further bonus, so an exact "bryant allred" beats a contact who
 * merely contains both tokens somewhere.
 */
function scoreToken(token: string, field: { kind: FieldKind; text: string }): number {
  const at = field.text.indexOf(token);
  if (at === -1) return 0;

  const base = FIELD_WEIGHT[field.kind];
  const atWordStart = at === 0 || field.text[at - 1] === " ";
  let score = atWordStart ? base * 2 : base;
  if (field.text === token) score += base;
  return score;
}

/**
 * Score a contact against the parsed tokens. Returns 0 when any token fails to
 * hit any field, which is what makes matching AND-across-tokens rather than OR.
 */
export function scoreContact(fields: SearchableFields, tokens: string[]): number {
  if (tokens.length === 0) return 0;

  let total = 0;
  for (const token of tokens) {
    let best = 0;
    for (const field of fields) {
      const score = scoreToken(token, field);
      if (score > best) best = score;
    }
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

/** Does this contact match the query at all? Ignores ranking. */
export function matchesSearch(contact: SearchableContact, query: string): boolean {
  const tokens = parseSearchTokens(query);
  if (tokens.length === 0) return true;
  return scoreContact(searchableFields(contact), tokens) > 0;
}

/**
 * Rank `contacts` against `query`, best first. A blank query returns the input
 * order untouched, so callers can use this unconditionally.
 *
 * Ties break on name so the order is stable and alphabetical within a score
 * band, rather than dependent on which page of a streamed load arrived first.
 */
export function searchContacts<T extends SearchableContact>(contacts: T[], query: string): T[] {
  const tokens = parseSearchTokens(query);
  if (tokens.length === 0) return contacts;

  const scored: Array<{ contact: T; score: number }> = [];
  for (const contact of contacts) {
    const score = scoreContact(searchableFields(contact), tokens);
    if (score > 0) scored.push({ contact, score });
  }

  scored.sort(
    (a, b) => b.score - a.score || (a.contact.name ?? "").localeCompare(b.contact.name ?? ""),
  );
  return scored.map((s) => s.contact);
}
