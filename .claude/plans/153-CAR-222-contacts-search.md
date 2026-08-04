# CAR-222 — Contacts search misses people

## What Dawson reported (2026-08-04)

- "when I search for names the right people don't come up"
- "when I have a name typed in and then activate that prospects chip, it doesn't refresh the results until I retype"
- "when I search Bryant Allred nothing comes up even tho he is a contact I have saved"

## What's actually wrong

Account shape, read off production: **9 active, 1140 prospects, 856 bench.** Bryant Allred
is contact 1484, `network_status = active`, name stored clean (`Bryant Allred`, 13 chars,
codepoint 32 for the space — verified, so this is not a stray-character problem).

Reproduced in `careervine/src/__tests__/contacts-search-scope.test.tsx`, 4 of 5 cases red
before the fix.

1. **Search is scoped to the toggled tiers.** `filteredContacts` filters `visibleContacts`,
   which is `contacts` narrowed to `enabledTiers`. The default view is active only, so the
   search box only ever sees 9 of 2005 people. Both the list and the suggestions dropdown
   read the same scoped set.
2. **Substring-only, untrimmed matching.** `q = searchQuery.toLowerCase()` — the `.trim()`
   is only used for the emptiness check. `"  Bryant Allred  "` misses, `"allred bryant"`
   misses, a double space inside a stored name misses, accented names miss when typed
   unaccented.
3. **No relevance ranking.** Matches keep alphabetical load order, so a company/title/tag
   hit can outrank an exact name hit.
4. **Chip toggle reads as frozen.** `useDeferredValue(enabledTiers)` moves the list
   re-render to a background lane. At ~1149 uncapped cards that render is slow enough to
   look like nothing happened until a keystroke forces an urgent render.
5. **Same matcher bug in the MCP server.** `matchesQuery` in `src/mcp/tools/contacts.ts`
   is the same substring-only check, and `search_contacts` slices the first N in load order.

## Fix

**New `src/lib/contact-search.ts`** — one matcher, shared by the web page and the MCP tool.

- `normalizeSearchText`: lowercase, NFD-strip diacritics, collapse whitespace.
- Query parses to tokens; a contact matches when **every** token hits **some** field.
- Fields carry weights so ranking is meaningful: name > email > company/title > school >
  industry > tag. Prefix and whole-token hits score above mid-string hits.
- `searchContacts(rows, query)` returns matches sorted by score, name as the tiebreak.

**`src/app/contacts/page.tsx`**

- With a query present, search **all loaded contacts** regardless of the tier chips. The
  chips stay a browse filter for the no-query case. Card avatars already signal tier
  (teal ring = prospect, grayscale = archive), so results from a toggled-off tier are
  still legible; a short line under the box says the search spans the whole network.
- Suggestions come from the same ranked result set.
- Drop `useDeferredValue` and cap rendered rows, with a "Show all N" control. Capping is
  what makes the deferral unnecessary: both the chip toggle and typing become cheap.

**`src/mcp/tools/contacts.ts`** — `matchesQuery` gives way to the shared ranked matcher, so
`search_contacts` returns the best N rather than the first N.

## Verification

- `contacts-search-scope.test.tsx` (repro suite) goes green.
- Unit tests for the matcher: tokens, order independence, whitespace, diacritics, ranking.
- MCP test that `search_contacts` ranks an exact name match above a tag match.
- `npm run test`, `npm run build`, `npm run check:conventions`.
