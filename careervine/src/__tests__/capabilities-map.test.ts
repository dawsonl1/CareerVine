import { describe, it, expect } from "vitest";
import { capabilitiesFor } from "@/lib/capabilities/map";
import type { Capability, EntitlementFlags } from "@/lib/capabilities/types";

const hasAll = (set: Set<Capability>, ...caps: Capability[]) => caps.every((c) => set.has(c));

// Explicit base so each case states its full tier posture. Defaults: connected,
// premium switch on, but no modify scope and automatic off (i.e. a connected free user).
const flags = (o: Partial<EntitlementFlags>): EntitlementFlags => ({
  modifyScopeGranted: false,
  automaticFeaturesEnabled: false,
  premiumEnabled: true,
  hasConnection: true,
  ...o,
});

describe("capabilitiesFor — the single source of truth for tier -> capability", () => {
  it("unconnected (no row) -> empty set", () => {
    const caps = capabilitiesFor(flags({ hasConnection: false }));
    expect(caps.size).toBe(0);
  });

  it("connected without the modify scope -> free Outreach portal only", () => {
    const caps = capabilitiesFor(flags({ modifyScopeGranted: false }));
    expect(caps.has("outreach:portal")).toBe(true);
    expect(caps.has("inbox:premium")).toBe(false);
    expect(caps.size).toBe(1);
  });

  it("premium (modify + premium_enabled), automatic off -> mailbox + drafts + inbox, NOT followups:auto, NOT outreach", () => {
    const caps = capabilitiesFor(flags({ modifyScopeGranted: true, premiumEnabled: true, automaticFeaturesEnabled: false }));
    expect(hasAll(caps, "mailbox:read", "mailbox:modify", "drafts:gmail", "inbox:premium")).toBe(true);
    expect(caps.has("followups:auto")).toBe(false);
    expect(caps.has("outreach:portal")).toBe(false);
    expect(caps.size).toBe(4);
  });

  it("premium + automatic -> full set including followups:auto", () => {
    const caps = capabilitiesFor(flags({ modifyScopeGranted: true, premiumEnabled: true, automaticFeaturesEnabled: true }));
    expect(hasAll(caps, "mailbox:read", "mailbox:modify", "drafts:gmail", "inbox:premium", "followups:auto")).toBe(true);
    expect(caps.has("outreach:portal")).toBe(false);
    expect(caps.size).toBe(5);
  });

  it("admin down-scope: modify held but premium_enabled=false -> free Outreach, no premium caps (no reconnect needed)", () => {
    const caps = capabilitiesFor(flags({ modifyScopeGranted: true, premiumEnabled: false, automaticFeaturesEnabled: true }));
    expect(caps.has("outreach:portal")).toBe(true);
    expect(caps.has("inbox:premium")).toBe(false);
    expect(caps.has("followups:auto")).toBe(false);
    expect(caps.size).toBe(1);
  });

  it("automatic enabled without premium -> no followups:auto (the scope is physical); connected -> outreach only", () => {
    const caps = capabilitiesFor(flags({ modifyScopeGranted: false, automaticFeaturesEnabled: true }));
    expect(caps.has("followups:auto")).toBe(false);
    expect(caps.has("outreach:portal")).toBe(true);
    expect(caps.size).toBe(1);
  });
});
