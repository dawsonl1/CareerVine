import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CAR-207: `/interactions` was a live authenticated route that never resolved.
 *
 * The page rendered a component taking `contactId` as a PROP, which Next never
 * passes. `loading` started true, the loader early-returned on the absent id,
 * and the effect that would have called it was gated on the same id, so the
 * spinner ran forever.
 *
 * It redirects rather than rendering a repaired page because the component had
 * zero importers and both of its jobs already belong elsewhere: `/meetings` owns
 * the standalone meetings + interactions timeline, and
 * `contact-timeline-tab.tsx` owns the contact-scoped view it was written to be.
 */

const nav = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    // The real `redirect()` throws a NEXT_REDIRECT sentinel rather than
    // returning, which is what makes the page's `never` return type sound.
    throw new Error(`NEXT_REDIRECT;${url}`);
  }),
}));
vi.mock("next/navigation", () => nav);

import InteractionsRedirectPage from "@/app/interactions/page";

beforeEach(() => vi.clearAllMocks());

describe("/interactions (CAR-207)", () => {
  it("redirects to the Activity page instead of rendering", () => {
    expect(() => InteractionsRedirectPage()).toThrow(/NEXT_REDIRECT/);
    expect(nav.redirect).toHaveBeenCalledWith("/meetings");
  });

  it("redirects rather than 404ing, so an existing bookmark still lands somewhere", () => {
    // notFound() would also stop the spinner; it would also strand anyone who
    // had the URL saved. The distinction is the product decision, so pin it.
    expect(() => InteractionsRedirectPage()).toThrow();
    expect(nav.redirect).toHaveBeenCalledTimes(1);
  });
});
