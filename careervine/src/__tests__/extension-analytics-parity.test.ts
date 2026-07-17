import { describe, it, expect, expectTypeOf } from "vitest";

// CAR-148 (F59) — the extension emits analytics events by name; those names must
// stay keys of the web app's AnalyticsEvents registry. background.js now reads
// them from a single const module (@ext/analytics-events); this test ties that
// module to the registry so renaming an event without updating the module (or
// vice versa) turns the suite red.

import { EXTENSION_ANALYTICS_EVENTS } from "@ext/analytics-events";
import type { AnalyticsEvent } from "@/lib/analytics/events";

type EmittedEventName = (typeof EXTENSION_ANALYTICS_EVENTS)[keyof typeof EXTENSION_ANALYTICS_EVENTS];

describe("extension analytics event-name parity", () => {
  it("exports exactly the extension-emitted event names", () => {
    expect(Object.values(EXTENSION_ANALYTICS_EVENTS).sort()).toEqual(
      ["extension_installed", "extension_logged_in", "profile_scraped"],
    );
  });

  it("every emitted name is a key of AnalyticsEvents (compile-time)", () => {
    // Fails to compile if any emitted name is not a registered analytics event.
    expectTypeOf<EmittedEventName>().toMatchTypeOf<AnalyticsEvent>();
  });
});
