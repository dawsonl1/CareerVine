# Investment Banking Recruiting — Banks & Office Locations

Preliminary reference dataset for a contact-networking tool scoped to IB recruiting.

**Scope:** US investment-banking / advisory / coverage offices only — the places where
analysts actually recruit and sit. Retail brokerage, wealth-management-only, and
back-office/operations sites are deliberately excluded (and flagged where they tend to
pollute location searches). International offices are omitted per current scope but are
easy to add later.

**Data model principle:** each **bank is a group**; each **office is a distinct node**
under it. "Lazard – Los Angeles" and "Lazard – San Francisco" are two separate records
that both roll up to the "Lazard" parent — because you network into a *specific office*,
not an abstract firm.

**Verification:** office lists were checked against each firm's official
locations/careers pages where reachable, and corroborated across secondary sources
otherwise. Confidence flags are noted inline. Compiled 2026-07-08.

---

## Tier 1 — Bulge Bracket (BB)

The full-service global banks. Note: **Credit Suisse is excluded** — UBS completed its
acquisition on 2023-06-12 and it no longer exists as a standalone bank.

| # | Bank | HQ | US IB office cities |
|---|------|----|--------------------|
| 1 | **Goldman Sachs** | New York, NY | New York NY · San Francisco CA · Los Angeles CA · Chicago IL · Houston TX · Dallas TX · Atlanta GA · Salt Lake City UT¹ |
| 2 | **Morgan Stanley** | New York, NY | New York NY · Menlo Park CA · San Francisco CA · Los Angeles CA · Houston TX · Chicago IL |
| 3 | **J.P. Morgan** | New York, NY | New York NY · San Francisco CA · Los Angeles CA · Chicago IL · Houston TX · Atlanta GA · Boston MA² |
| 4 | **BofA Securities** | New York, NY / Charlotte, NC | New York NY · Charlotte NC · San Francisco CA · Chicago IL · Houston TX · Los Angeles CA · Dallas TX · Atlanta GA |
| 5 | **Citi** | New York, NY | New York NY · San Francisco CA · Los Angeles CA · Houston TX · Chicago IL |
| 6 | **Barclays** | New York, NY (US) | New York NY · San Francisco CA · Menlo Park CA · Los Angeles CA · Chicago IL · Houston TX · Atlanta GA |
| 7 | **UBS** | New York, NY (US) | New York NY · San Francisco CA · Los Angeles CA · Chicago IL · Houston TX |
| 8 | **Deutsche Bank** | New York, NY (US) | New York NY · San Francisco CA · Chicago IL · Houston TX |

¹ Goldman SLC is a very large office but skews engineering/operations — include as a hub, not a core coverage seat.
² JPM Boston is probable (coverage) but wasn't firmly confirmed; treat as tentative.

---

## Tier 1.5 — Balance-sheet / corporate banks (BB-adjacent)

Large full-service IB platforms usually ranked just outside the classic bulge bracket.

| # | Bank | HQ | US IB office cities |
|---|------|----|--------------------|
| 9 | **Wells Fargo** (Corp. & Investment Banking) | Charlotte, NC (CIB) | Charlotte NC · New York NY · Chicago IL · Houston TX · San Francisco CA · Los Angeles CA · Boston MA |
| 10 | **RBC Capital Markets** | New York, NY (US) | New York NY · San Francisco CA · Los Angeles CA · Chicago IL · Houston TX · Dallas TX · Austin TX · Atlanta GA · Boston MA · Minneapolis MN · Charlotte NC |

*RBC publishes 30+ US offices; the long tail is wealth-management / muni / ops and is excluded above.*

---

## Tier 2 — Elite Boutiques (EB)

Independent advisory firms (M&A / restructuring). Compact footprints — every office matters.

| # | Firm | HQ | US IB office cities |
|---|------|----|--------------------|
| 11 | **Centerview Partners** | New York, NY | New York NY · Menlo Park CA · San Francisco CA |
| 12 | **Evercore** | New York, NY | New York NY · Boston MA · Chicago IL · Dallas TX · Houston TX · Los Angeles CA · Menlo Park CA · Minneapolis MN · San Francisco CA · Washington DC³ |
| 13 | **Lazard** | New York, NY | New York NY · Austin TX · Boston MA · Charlotte NC · Chicago IL · Houston TX · Los Angeles CA · Minneapolis MN · San Francisco CA |
| 14 | **Moelis & Company** | New York, NY | New York NY · Boston MA · Chicago IL · Houston TX · Los Angeles CA · San Francisco CA · Washington DC · West Palm Beach FL |
| 15 | **PJT Partners** | New York, NY | New York NY · Boston MA · Chicago IL · Houston TX · Los Angeles CA · San Francisco CA |
| 16 | **Perella Weinberg Partners** | New York, NY | New York NY · Houston TX · Los Angeles CA · San Francisco CA · Chicago IL · Denver CO · Palm Beach FL · Greenwich CT |
| 17 | **Qatalyst Partners** | San Francisco, CA | San Francisco CA |
| 18 | **Guggenheim Securities** | New York, NY | New York NY · Atlanta GA · Boston MA · Chicago IL · Houston TX · Menlo Park CA · San Francisco CA |
| 19 | **Rothschild & Co** (Global Advisory) | New York, NY (NA) | New York NY · Boston MA · Los Angeles / Santa Monica CA · San Francisco CA |

³ Evercore also runs several wealth-management / private-capital-only US offices (Warren NJ, Westport CT, Richmond VA, Wilmington DE, Tampa & West Palm Beach FL) — excluded here as non-IB-recruiting.

---

## Tier 3 — Middle Market & elite middle market (MM)

Includes "elite MM" shops (Jefferies, Houlihan Lokey, Baird, William Blair, Harris
Williams) that recruit heavily and place strongly.

| # | Firm | HQ | US IB office cities |
|---|------|----|--------------------|
| 20 | **Jefferies** | New York, NY | New York NY · Boston MA · Stamford CT · Charlotte NC · Richmond VA · Miami FL · Nashville TN · Chicago IL · Dallas TX · Houston TX · Palo Alto CA · San Francisco CA · Los Angeles CA |
| 21 | **Houlihan Lokey** | Los Angeles, CA | Los Angeles CA · New York NY · Chicago IL · San Francisco CA · Minneapolis MN · Dallas TX · Houston TX · Atlanta GA · Boston MA · Charlotte NC · Miami FL · Baltimore MD · Washington DC |
| 22 | **William Blair** | Chicago, IL | Chicago IL · New York NY · San Francisco CA · Los Angeles CA · Atlanta GA · Charlotte NC⁴ |
| 23 | **Robert W. Baird** | Milwaukee, WI | Milwaukee WI · Chicago IL · New York NY · Boston MA · Charlotte NC · Denver CO · Louisville KY · Nashville TN⁵ |
| 24 | **Harris Williams** | Richmond, VA | Richmond VA · Boston MA · New York NY · Washington DC · Cleveland OH · Minneapolis MN · Chicago IL · San Francisco CA · Charlotte NC |
| 25 | **Piper Sandler** | Minneapolis, MN | Minneapolis MN · New York NY · Boston MA · Chicago IL · Charlotte NC · Houston TX · San Francisco CA · Los Angeles CA · Denver CO · Nashville TN⁶ |
| 26 | **Stifel** | St. Louis, MO | St. Louis MO · New York NY · Baltimore MD · Boston MA · Chicago IL · San Francisco CA · Denver CO · Houston TX · Atlanta GA · Los Angeles CA · Miami FL · Washington DC · Minneapolis MN |
| 27 | **KBW** (Keefe, Bruyette & Woods — a Stifel co.) | New York, NY | New York NY · Boston MA · Hartford CT · Richmond VA · Atlanta GA · Chicago IL · Austin TX · San Francisco CA · Columbus OH |
| 28 | **Raymond James** | St. Petersburg, FL | St. Petersburg FL · New York NY · Atlanta GA · Boston MA · Charlotte NC · Chicago IL · Dallas TX⁷ |
| 29 | **Lincoln International** | Chicago, IL | Chicago IL · New York NY · Boston MA · Atlanta GA · Dallas TX · Los Angeles CA · San Francisco CA · Richmond VA · McLean VA (DC) · Miami FL · Cleveland OH |
| 30 | **TD Cowen** | New York, NY | New York NY · San Francisco CA · Washington DC · El Segundo CA (LA) · Dallas TX⁸ |

⁴ William Blair also runs wealth-management-only offices (Boston, Philadelphia, Stamford, Baltimore, Denver, Columbus, etc.) — excluded.
⁵ Baird core IB list; several additional equity-capital-markets cities (SF, Houston, Dallas, Cleveland, St. Louis, etc.) are front-office-adjacent but IB presence is unconfirmed. 155+ wealth branches excluded.
⁶ Piper Sandler publishes 60+ US sites; most are fixed-income / public-finance / wealth branches and are excluded. Nashville tentative.
⁷ Raymond James runs 3,400+ retail advisor branches — **excluded entirely**. Additional IB cities (Houston, Denver, Nashville, Newport Beach) are plausible but unconfirmed.
⁸ TD Cowen's standalone locations page now redirects to TD Securities post-merger; 5 US cities confirmed. Legacy Cowen hubs (Boston, Chicago, Atlanta, Cleveland, Stamford) need re-verification.

---

## Quick stats

- **30 firms** across four tiers (8 BB · 2 BB-adjacent · 9 EB · 11 MM).
- **~150 distinct US offices** once deduped by firm+city.
- **Universal hubs** (every tier, most firms): New York, San Francisco, Los Angeles, Chicago, Houston.
- **Coverage-specialized cities:** Menlo Park / Palo Alto (tech) · Houston (energy) · Charlotte (Wells/BofA balance-sheet) · Minneapolis (Piper/HL/Lazard) · Boston (healthcare/tech).

## Data-quality notes

- **Highest confidence** (official page enumerated cities): Centerview, Evercore, Moelis, Perella Weinberg, Qatalyst, Lincoln International, Piper Sandler, Harris Williams, Jefferies, KBW.
- **Assembled from careers/coverage sources** (no single canonical IB-office page): JPMorgan, BofA, Goldman, Stifel, Raymond James, TD Cowen.
- Anything marked "tentative" / "verify" above should get a manual check before it's treated as canonical seed data.
