/**
 * React binding for school affinity (CAR-213).
 *
 * Lives in hooks/ rather than lib/schools/ because reading the signed-in user
 * means importing the auth provider, and architecture-boundaries.test.ts
 * enforces that src/lib never points at a component. The pure resolution is in
 * @/lib/schools/affinity-state.
 *
 * Source is `user_metadata.university`, mirrored from public.users on signup
 * and on every profile save — the same dual-write first_name/last_name have
 * always used. That mirror is what makes this synchronous: every badge, count,
 * and copy variant needs the answer, and a DB read per component would be
 * dozens of round trips for one short string.
 *
 * public.users.university stays CANONICAL. Nothing server-side may trust the
 * metadata copy: a user can edit their own metadata through the Supabase
 * client, so the bundle sync filter reads the table instead. Otherwise a user
 * could grant themselves the alumni prospects by editing a JWT claim.
 */

"use client";

import { useMemo } from "react";
import { useAuth } from "@/components/auth-provider";
import { alumniAffinityFor, type AlumniAffinity } from "@/lib/schools/affinity-state";

export function useAlumniAffinity(): AlumniAffinity {
  const { user } = useAuth();
  const university = user?.user_metadata?.university as string | undefined;
  return useMemo(() => alumniAffinityFor(university), [university]);
}
