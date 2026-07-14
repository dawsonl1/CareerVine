// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  FollowUpPlanSection,
  followUpPlanFooterCopy,
  type FollowUpDraft,
} from "@/components/follow-up-plan-section";

const caps = vi.hoisted(() => ({ autoCancel: false }));

vi.mock("@/hooks/use-capabilities", () => ({
  useCapabilities: () => ({
    can: (cap: string) => cap === "followups:auto" && caps.autoCancel,
    loading: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/components/ui/rich-text-editor", () => ({
  RichTextEditor: () => <div data-testid="rte" />,
}));

const sampleFollowUps: FollowUpDraft[] = [
  {
    id: "fu-1",
    subject: "Re: Hi",
    bodyHtml: "<p>Just checking in</p>",
    delayDays: 7,
    projectedDate: "Tue, Jul 21 · 9:05 AM",
  },
];

const noop = () => {};

describe("followUpPlanFooterCopy", () => {
  it("returns auto-cancel copy for premium auto follow-ups", () => {
    expect(followUpPlanFooterCopy({ autoCancel: true, recipientFirstName: "Maija" })).toBe(
      "Auto-cancels if they reply."
    );
  });

  it("returns confirm copy with first name for free tier", () => {
    expect(followUpPlanFooterCopy({ autoCancel: false, recipientFirstName: "Maija" })).toBe(
      "You'll confirm Maija hasn't replied before each follow-up email is sent."
    );
  });

  it("falls back when no first name", () => {
    expect(followUpPlanFooterCopy({ autoCancel: false, recipientFirstName: null })).toBe(
      "You'll confirm they haven't replied before each follow-up email is sent."
    );
  });
});

describe("FollowUpPlanSection", () => {
  it("shows a visible switch knob when enabled (shared Toggle)", () => {
    caps.autoCancel = false;
    render(
      <FollowUpPlanSection
        followUps={sampleFollowUps}
        enabled
        loading={false}
        error={null}
        placeholder={false}
        recipientFirstName="Maija"
        onToggle={noop}
        onEdit={noop}
        onRemove={noop}
        onRetry={noop}
      />
    );
    const sw = screen.getByRole("switch");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(sw.querySelector("span")).toBeTruthy();
  });

  it("renders free-tier footer copy with first name", () => {
    caps.autoCancel = false;
    render(
      <FollowUpPlanSection
        followUps={sampleFollowUps}
        enabled
        loading={false}
        error={null}
        placeholder={false}
        recipientFirstName="Maija"
        onToggle={noop}
        onEdit={noop}
        onRemove={noop}
        onRetry={noop}
      />
    );
    expect(
      screen.getByText("You'll confirm Maija hasn't replied before each follow-up email is sent.")
    ).toBeTruthy();
  });

  it("renders auto-cancel footer when followups:auto is granted", () => {
    caps.autoCancel = true;
    render(
      <FollowUpPlanSection
        followUps={sampleFollowUps}
        enabled
        loading={false}
        error={null}
        placeholder={false}
        recipientFirstName="Maija"
        onToggle={noop}
        onEdit={noop}
        onRemove={noop}
        onRetry={noop}
      />
    );
    expect(screen.getByText("Auto-cancels if they reply.")).toBeTruthy();
  });

  it("caps the body with a scrollable max-height region", () => {
    caps.autoCancel = false;
    const { container } = render(
      <FollowUpPlanSection
        followUps={sampleFollowUps}
        enabled
        loading={false}
        error={null}
        placeholder={false}
        onToggle={noop}
        onEdit={noop}
        onRemove={noop}
        onRetry={noop}
      />
    );
    expect(container.innerHTML).toContain("max-h-[min(360px,45vh)]");
    expect(container.innerHTML).toContain("overflow-y-auto");
  });
});
