/**
 * Affinity resolution for the account holder's school (CAR-213).
 *
 * Pure: the React binding lives in @/hooks/use-alumni-affinity, because
 * architecture-boundaries.test.ts enforces that nothing under src/lib imports
 * a component — and reading the user means importing the auth provider.
 *
 * Source is `user_metadata.university`, mirrored from public.users on signup
 * and on every profile save — the same dual-write first_name/last_name have
 * used since the beginning (account-section.tsx calls updateUserProfile then
 * supabase.auth.updateUser). That mirror is what makes this hook synchronous:
 * every badge, count, and copy variant in the app needs the answer, and a DB
 * read per component would be dozens of round trips for one short string.
 *
 * WHICH SOURCE IS CANONICAL: public.users.university, always. The metadata
 * copy is a display cache and nothing server-side may trust it — the bundle
 * sync filter reads the table, because a user can edit their own metadata
 * through the Supabase client and must not be able to grant themselves the
 * alumni prospects that way.
 *
 * Returns THREE states, not two, because the two non-affinity states need
 * different copy: a user who named a non-BYU school gets told why their
 * database is smaller, a user who named nothing gets invited to add one.
 */

import { abbrFor, hasAlumniAffinity } from "./affinity";

export type AffinityState = "byu_family" | "other_school" | "no_school";

export interface AlumniAffinity {
  /** The gate. Drives every badge, count, sort, and filter. */
  hasAffinity: boolean;
  /** Which of the three product states this user is in. */
  state: AffinityState;
  /** Raw stored value, for copy that names the school. */
  university: string | null;
  /**
   * How to label the school in a badge or count ("2 UCLA alumni").
   * Null for an escape-hatch school with no curated abbreviation; callers
   * render "Alum" and drop the school from counts rather than jamming a
   * truncated free-text name into a chip.
   */
  abbr: string | null;
}

export function alumniAffinityFor(university: string | null | undefined): AlumniAffinity {
  const value = university?.trim() ? university.trim() : null;
  const hasAffinity = hasAlumniAffinity(value);
  return {
    hasAffinity,
    state: hasAffinity ? "byu_family" : value ? "other_school" : "no_school",
    university: value,
    abbr: abbrFor(value),
  };
}

/**
 * The word a badge shows. "Alum" is the fallback rather than the school's full
 * name because an escape-hatch entry has no curated abbreviation and a
 * truncated free-text name in a 10px chip reads as broken.
 */
export function alumBadgeLabel(affinity: AlumniAffinity): string {
  return affinity.abbr ?? "Alum";
}

/**
 * "2 UCLA alumni" when there is an abbreviation, "2 alumni" when there is not.
 * Callers pass the already-pluralized noun so this never has to know English.
 */
export function alumCountLabel(affinity: AlumniAffinity, count: number, noun: string): string {
  return affinity.abbr ? `${count} ${affinity.abbr} ${noun}` : `${count} ${noun}`;
}
