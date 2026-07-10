/**
 * Bundle-access shapes + pure helpers for the admin surface.
 *
 * Visibility itself is enforced in Postgres RLS via bundle_visible_to();
 * `effectiveBundleVisibility` mirrors that predicate in TS so the admin UI
 * can display (and tests can assert) the same rule: explicit override wins,
 * else the bundle default.
 */

export interface BundleAccessItem {
  bundleId: number;
  slug: string;
  name: string;
  description: string | null;
  prospectCount: number;
  defaultVisible: boolean;
  /** Per-user override: true = granted, false = denied, null = no override. */
  override: boolean | null;
  /** What the user actually experiences (mirror of bundle_visible_to). */
  visible: boolean;
  subscribed: boolean;
}

/** Mirror of the SQL bundle_visible_to() predicate. */
export function effectiveBundleVisibility(
  defaultVisible: boolean,
  override: boolean | null,
): boolean {
  if (override === false) return false;
  if (override === true) return true;
  return defaultVisible;
}

/**
 * List-view summary: how many published bundles one user can see.
 * `overrides` maps bundleId → allowed for that user (absent = no override).
 */
export function bundleVisibilityCount(
  bundles: Array<{ id: number; defaultVisible: boolean }>,
  overrides: ReadonlyMap<number, boolean>,
): { visible: number; total: number } {
  let visible = 0;
  for (const b of bundles) {
    const override = overrides.has(b.id) ? (overrides.get(b.id) as boolean) : null;
    if (effectiveBundleVisibility(b.defaultVisible, override)) visible++;
  }
  return { visible, total: bundles.length };
}
