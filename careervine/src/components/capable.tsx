"use client";

import type { ReactNode } from "react";
import { useCapabilities } from "@/hooks/use-capabilities";
import type { Capability } from "@/lib/capabilities/types";

/**
 * Declarative capability gate (CAR-103). Renders `children` only when the user
 * has `capability`; otherwise renders `fallback` (default: nothing). While
 * capabilities are still resolving it renders `fallback` too — fail-closed, so a
 * paid-only control never flashes for a free user.
 *
 *   <Capable capability="mailbox:read"><SyncButton /></Capable>
 */
export function Capable({
  capability,
  children,
  fallback = null,
}: {
  capability: Capability;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { can, loading } = useCapabilities();
  if (loading || !can(capability)) return <>{fallback}</>;
  return <>{children}</>;
}
