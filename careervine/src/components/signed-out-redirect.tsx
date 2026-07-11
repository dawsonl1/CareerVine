"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import { hardNavigate } from "@/lib/hard-navigate";
import { isPublicPath } from "@/lib/public-routes";

/**
 * Bounces sessionless visitors on app pages back to the landing page (CAR-64).
 *
 * Covers the stranded-tab case: sign out in one tab (clearing the shared auth
 * cookies), refresh another tab sitting on /contacts etc. — without this, the
 * page renders a dead shell with no navbar and no way to navigate. Reacting to
 * auth state (not just mount) also redirects a live tab the moment a SIGNED_OUT
 * event reaches it. hardNavigate, matching signOut, so a full load discards all
 * in-memory state from the dead session.
 */
export function SignedOutRedirect({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const pathname = usePathname();
  const shouldRedirect = !loading && !user && !isPublicPath(pathname);

  useEffect(() => {
    if (shouldRedirect) hardNavigate("/");
  }, [shouldRedirect]);

  // Render nothing while the redirect is in flight — not the dead shell.
  if (shouldRedirect) return null;

  return <>{children}</>;
}
