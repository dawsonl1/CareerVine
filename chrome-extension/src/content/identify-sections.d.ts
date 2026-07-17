// Types for identify-sections.js (a plain JS module shared as-is between the
// content script and the web app's vitest suite via the @ext alias). Lets the
// suite import it without a `@ts-expect-error` (CAR-148 F34).

/** A [start, end) line-index span within the profile text. */
export interface SectionSpan {
  start: number;
  end: number;
}

/** Section boundaries for a scraped LinkedIn profile; sections absent from the
 *  page are null. `header` always spans at least the top lines. */
export interface ProfileSections {
  header: SectionSpan;
  highlights: SectionSpan | null;
  about: SectionSpan | null;
  services: SectionSpan | null;
  featured: SectionSpan | null;
  activity: SectionSpan | null;
  experience: SectionSpan | null;
  education: SectionSpan | null;
}

export declare function identifySections(lines: string[]): ProfileSections;
