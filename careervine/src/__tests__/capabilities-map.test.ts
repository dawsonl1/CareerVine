import { describe, it, expect } from "vitest";
import { capabilitiesFor } from "@/lib/capabilities/map";
import type { Capability } from "@/lib/capabilities/types";

const hasAll = (set: Set<Capability>, ...caps: Capability[]) => caps.every((c) => set.has(c));

describe("capabilitiesFor — the single source of truth for tier -> capability", () => {
  it("no flags -> empty set (free tier)", () => {
    const caps = capabilitiesFor({ modifyScopeGranted: false, automaticFeaturesEnabled: false });
    expect(caps.size).toBe(0);
  });

  it("modify scope only -> mailbox + drafts + premium inbox, but NOT followups:auto", () => {
    const caps = capabilitiesFor({ modifyScopeGranted: true, automaticFeaturesEnabled: false });
    expect(hasAll(caps, "mailbox:read", "mailbox:modify", "drafts:gmail", "inbox:premium")).toBe(true);
    expect(caps.has("followups:auto")).toBe(false);
    expect(caps.size).toBe(4);
  });

  it("automatic entitlement WITHOUT the scope -> still empty (both flags required; the scope is physical)", () => {
    const caps = capabilitiesFor({ modifyScopeGranted: false, automaticFeaturesEnabled: true });
    expect(caps.size).toBe(0);
  });

  it("both flags -> full set including followups:auto", () => {
    const caps = capabilitiesFor({ modifyScopeGranted: true, automaticFeaturesEnabled: true });
    expect(hasAll(caps, "mailbox:read", "mailbox:modify", "drafts:gmail", "inbox:premium", "followups:auto")).toBe(true);
    expect(caps.size).toBe(5);
  });
});
