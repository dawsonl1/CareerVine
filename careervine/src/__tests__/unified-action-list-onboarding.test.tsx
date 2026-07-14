// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import {
  UnifiedActionList,
  type UnifiedActionItem,
} from "@/components/home/unified-action-list";

afterEach(cleanup);

const onboardingItem: UnifiedActionItem = {
  id: "ob-1",
  type: "onboarding",
  contactId: 0,
  contactName: "Getting started",
  contactPhotoUrl: null,
  primaryText: "Download the LinkedIn scraping Chrome extension to import your first contact",
  secondaryText: "",
  lastContactedLabel: "",
  priority: 90,
  actionItemId: 1,
};

function renderList(
  items: UnifiedActionItem[],
  isEmpty: boolean,
  onOpenOnboarding = vi.fn(),
  opts: { dismissedGettingStarted?: string[]; onDismissGettingStarted?: () => void } = {},
) {
  render(
    <UnifiedActionList
      items={items}
      loading={false}
      onComplete={vi.fn()}
      onSnooze={vi.fn()}
      onDismiss={vi.fn()}
      onSave={vi.fn()}
      onLogInteraction={vi.fn()}
      onDraftEmail={vi.fn()}
      onNote={vi.fn()}
      onIntro={vi.fn()}
      onOpenOnboarding={onOpenOnboarding}
      isEmpty={isEmpty}
      onLogConversation={vi.fn()}
      calendarConnected={true}
      dismissedGettingStarted={opts.dismissedGettingStarted ?? []}
      onDismissGettingStarted={opts.onDismissGettingStarted ?? vi.fn()}
    />,
  );
  return onOpenOnboarding;
}

describe("UnifiedActionList onboarding row (CAR-68)", () => {
  it("renders the onboarding to-do as a clickable row that opens the flow", () => {
    const onOpen = renderList([onboardingItem], false);
    expect(screen.getByText("Getting started")).toBeTruthy();
    expect(screen.getByText(/Download the LinkedIn scraping Chrome extension/)).toBeTruthy();
    expect(screen.getByText("GET STARTED")).toBeTruthy();

    fireEvent.click(screen.getByText("Getting started"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][0].actionItemId).toBe(1);
  });

  it("does not link the onboarding row to a contact page", () => {
    renderList([onboardingItem], false);
    expect(document.querySelector('a[href="/contacts/0"]')).toBeNull();
  });

  it("renders no complete/snooze affordances on the onboarding row", () => {
    renderList([onboardingItem], false);
    expect(screen.queryByText("Done")).toBeNull();
    expect(screen.queryByText("Snooze")).toBeNull();
  });

  it("empty state shows the row above getting-started, minus the redundant extension card", () => {
    renderList([onboardingItem], true);
    // The to-do row renders inside the empty state…
    expect(screen.getByText("Getting started")).toBeTruthy();
    // …alongside the checklist…
    expect(screen.getByText("Add the curated target database")).toBeTruthy();
    // …whose own extension card is dropped as redundant.
    expect(screen.queryByText("Install the Chrome extension")).toBeNull();
  });

  it("empty state keeps the extension card when there is no onboarding to-do", () => {
    renderList([], true);
    expect(screen.getByText("Install the Chrome extension")).toBeTruthy();
  });

  it("extension card opens the Chrome Web Store listing", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    try {
      renderList([], true);
      fireEvent.click(screen.getByText("Install the Chrome extension"));
      expect(open).toHaveBeenCalledWith(
        "https://chromewebstore.google.com/detail/careervine-linkedin-integ/jdiefmjeiihacjencfdempbgapnppooj",
        "_blank",
        "noopener",
      );
    } finally {
      open.mockRestore();
    }
  });
});

describe("Getting-started checklist dismissal (CAR-73)", () => {
  it("filters out dismissed rows by id", () => {
    renderList([], true, vi.fn(), {
      dismissedGettingStarted: ["getting-started-bundle", "getting-started-log"],
    });
    expect(screen.queryByText("Add the curated target database")).toBeNull();
    expect(screen.queryByText("Log your first conversation")).toBeNull();
    // Untouched rows still render.
    expect(screen.getByText("Pick a target company")).toBeTruthy();
  });

  it("dismiss button fires with the row id and does not navigate", () => {
    const onDismiss = vi.fn();
    const assign = vi.fn();
    const originalLocation = window.location;
    // window.location.assign is what the row's onClick calls; spy on it to
    // prove the dismiss click is stopped from bubbling to the row.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, assign },
    });
    try {
      renderList([], true, vi.fn(), { onDismissGettingStarted: onDismiss });
      fireEvent.click(screen.getByLabelText('Dismiss "Pick a target company"'));
      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(onDismiss).toHaveBeenCalledWith("getting-started-company");
      expect(assign).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it("shows an all-set message when every row is dismissed and there is no onboarding row", () => {
    renderList([], true, vi.fn(), {
      dismissedGettingStarted: [
        "getting-started-bundle",
        "getting-started-company",
        "getting-started-calendar",
        "getting-started-extension",
        "getting-started-log",
      ],
    });
    expect(screen.queryByText("Add the curated target database")).toBeNull();
    expect(screen.getByText(/You're all set/)).toBeTruthy();
  });
});
