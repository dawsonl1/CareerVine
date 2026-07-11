"use client";

/**
 * Admin user-detail: per-bundle access card.
 *
 * Thin card wrapper — the fetch/toggle logic lives in BundleAccessList, which
 * the admin users-list row expander shares (CAR-36). Visibility ≠ subscription:
 * granting only lets the user SEE the bundle in Settings → Data subscriptions —
 * they still subscribe themselves.
 */

import BundleAccessList from "@/components/admin/bundle-access-list";

export default function BundlesSection({ userId }: { userId: string }) {
  return (
    <section className="rounded-2xl border border-outline-variant bg-surface p-5">
      <h2 className="text-lg font-medium text-on-surface">Data bundles</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Control which bundles this account can see. Granting lets them subscribe
        from Settings, but it doesn&apos;t add contacts for them.
      </p>
      <BundleAccessList userId={userId} />
    </section>
  );
}
