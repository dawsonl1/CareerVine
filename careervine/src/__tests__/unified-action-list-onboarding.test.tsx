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

function renderList(items: UnifiedActionItem[], isEmpty: boolean, onOpenOnboarding = vi.fn()) {
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
});
