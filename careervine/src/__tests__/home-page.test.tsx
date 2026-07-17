// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";

/**
 * CAR-154 / F21: a failed core-data load with nothing cached must render a
 * retryable error state, not the misleading getting-started / new-user view.
 * A genuinely empty (but successful) load must still show the workspace.
 */

const q = vi.hoisted(() => ({
  getHomeCoreData: vi.fn(),
  getActionListCounts: vi.fn(),
  getContactEmailLookup: vi.fn(),
  getRelationshipsOnTrack: vi.fn(),
  getNetworkingStreak: vi.fn(),
  getHomeStats: vi.fn(),
  getActivityHeatmap: vi.fn(),
  getNetworkHealthSummary: vi.fn(),
  getNeglectedContacts: vi.fn(),
  updateActionItem: vi.fn(),
  appendContactNote: vi.fn(),
  snoozeActionItem: vi.fn(),
  snoozeContact: vi.fn(),
  skipContactFirstOutreach: vi.fn(),
  setSuggestionCooldown: vi.fn(),
  getDismissedGettingStarted: vi.fn(),
  setDismissedGettingStarted: vi.fn(),
}));

vi.mock("@/components/navigation", () => ({ __esModule: true, default: () => <nav /> }));
vi.mock("@/components/landing-page", () => ({ __esModule: true, default: () => <div>landing</div> }));
vi.mock("@/components/auth-provider", () => {
  const user = { id: "u-1", user_metadata: {} };
  return { useAuth: () => ({ user, loading: false }) };
});
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/quick-capture-context", () => ({ useQuickCapture: () => ({ open: vi.fn() }) }));
vi.mock("@/components/onboarding/extension-onboarding-context", () => ({ useExtensionOnboarding: () => ({ open: vi.fn() }) }));
vi.mock("@/components/compose-email-context", () => ({ useCompose: () => ({ openCompose: vi.fn() }) }));
vi.mock("@/hooks/use-gmail-connection", () => ({ useGmailConnection: () => ({ calendarConnected: false, loading: false }) }));
vi.mock("@/hooks/use-suggestions", () => ({
  useSuggestions: () => ({ suggestions: [], loading: false, save: vi.fn(), complete: vi.fn(), dismiss: vi.fn(), triggerOnce: vi.fn() }),
}));
vi.mock("@/components/home/log-conversation-fab", () => ({ LogConversationFab: () => <div /> }));
vi.mock("@/components/home/unified-action-list", () => ({ UnifiedActionList: () => <div data-testid="unified-action-list" /> }));
vi.mock("@/components/home/today-schedule", () => ({ TodaySchedule: () => <div /> }));
vi.mock("@/components/home/discovery-digest", () => ({ DiscoveryDigest: () => <div /> }));
vi.mock("@/components/home/networking-stats", () => ({ NetworkingStats: () => <div /> }));
vi.mock("@/lib/queries", () => q);

import Home from "@/app/page";

function primeBands() {
  q.getActionListCounts.mockResolvedValue({ actionItems: 0, reachOut: 0, recentlyAdded: 0 });
  q.getHomeStats.mockResolvedValue({});
  q.getActivityHeatmap.mockResolvedValue([]);
  q.getNetworkHealthSummary.mockResolvedValue({});
  q.getNeglectedContacts.mockResolvedValue([]);
  q.getRelationshipsOnTrack.mockResolvedValue({});
  q.getNetworkingStreak.mockResolvedValue({ streak: 0 });
  q.getDismissedGettingStarted.mockResolvedValue([]);
  q.getContactEmailLookup.mockResolvedValue(new Map());
}

beforeEach(() => {
  vi.clearAllMocks();
  primeBands();
  try { localStorage.clear(); } catch { /* jsdom localStorage may be absent */ }
});
afterEach(() => cleanup());

describe("Home — honest load-failure state (F21)", () => {
  it("renders a retryable error state when core data fails to load", async () => {
    q.getHomeCoreData.mockRejectedValue(new Error("boom"));

    render(<Home />);
    await waitFor(() => expect(screen.getByText("We could not load your dashboard")).toBeTruthy());
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
  });

  it("shows the workspace (not the error state) on a successful empty load", async () => {
    q.getHomeCoreData.mockResolvedValue({ actionItems: [], recentlyAdded: [], followUps: [], contactHealth: [] });

    render(<Home />);
    await waitFor(() => expect(screen.getByTestId("unified-action-list")).toBeTruthy());
    expect(screen.queryByText("We could not load your dashboard")).toBeNull();
  });
});
