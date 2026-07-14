// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

/**
 * CAR-120: the compose popup can attach a follow-up sequence for a known contact,
 * and the "Schedule" flow uses the custom Date/Time pickers instead of the native
 * <input type="datetime-local">.
 */

// A mutable compose-context stub so each test can vary contactId / reply / intro.
const mock = vi.hoisted(() => {
  const defaults = {
    isOpen: true,
    prefillTo: "",
    prefillName: "",
    prefillSubject: "",
    prefillBodyHtml: "",
    replyThreadId: "",
    replyInReplyTo: "",
    replyReferences: "",
    replyQuotedHtml: "",
    aiDraftContext: null,
    existingDraftId: null,
    isIntro: false,
    contactId: 0,
    templateFollowUps: null,
    gmailAddress: "me@gmail.com",
    closeCompose: () => {},
    openCompose: () => {},
  };
  return { state: { ...defaults }, defaults };
});

vi.mock("@/components/compose-email-context", () => ({ useCompose: () => mock.state }));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { id: "u-1" } }),
}));
vi.mock("@/hooks/use-capabilities", () => ({
  useCapabilities: () => ({
    capabilities: new Set(),
    loading: false,
    can: () => true,
    refresh: async () => {},
  }),
}));

// Heavy children — irrelevant to this behavior, and TipTap is unstable in jsdom.
vi.mock("@/components/ui/rich-text-editor", () => ({ RichTextEditor: () => <div data-testid="rte" /> }));
vi.mock("@/components/ai-write-dropdown", () => ({ AiWriteDropdown: () => <div /> }));
vi.mock("@/components/availability-picker", () => ({ AvailabilityPicker: () => <div /> }));
vi.mock("@/components/intro-context-form", () => ({ IntroContextForm: () => <div /> }));
vi.mock("@/lib/queries", () => ({
  getEmailProvenance: async () => null,
  markEmailVerified: async () => {},
}));
vi.mock("@/lib/analytics/client", () => ({ track: () => {} }));

import { ComposeEmailModal } from "@/components/compose-email-modal";

function resetState() {
  Object.assign(mock.state, mock.defaults, { closeCompose: () => {}, openCompose: () => {} });
}

describe("ComposeEmailModal — follow-ups + custom scheduler (CAR-120)", () => {
  beforeEach(() => {
    resetState();
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
  });
  afterEach(() => cleanup());

  it("offers 'Add follow-ups' when the recipient is a known contact", () => {
    mock.state.contactId = 5;
    mock.state.prefillTo = "jane@corp.com";
    mock.state.prefillSubject = "Coffee?";
    render(<ComposeEmailModal />);
    expect(screen.getByText("Add follow-ups")).toBeTruthy();
  });

  it("hides follow-ups for a raw email with no contact", () => {
    mock.state.contactId = 0;
    mock.state.prefillTo = "stranger@x.com";
    mock.state.prefillSubject = "Hi";
    render(<ComposeEmailModal />);
    expect(screen.queryByText("Add follow-ups")).toBeNull();
  });

  it("hides follow-ups for a reply even to a contact (already in-thread)", () => {
    mock.state.contactId = 5;
    mock.state.replyThreadId = "t1";
    mock.state.prefillTo = "jane@corp.com";
    render(<ComposeEmailModal />);
    expect(screen.queryByText("Add follow-ups")).toBeNull();
  });

  it("Schedule uses the custom date/time pickers, not a native datetime input", () => {
    mock.state.contactId = 5;
    mock.state.prefillTo = "jane@corp.com";
    mock.state.prefillSubject = "Hi";
    const { container } = render(<ComposeEmailModal />);
    fireEvent.click(screen.getByText("Schedule"));
    expect(container.querySelector('input[type="datetime-local"]')).toBeNull();
    expect(screen.getByText("Schedule send")).toBeTruthy();
  });

  it("adds a manual follow-up step by hand (no AI needed)", () => {
    mock.state.contactId = 5;
    mock.state.prefillTo = "jane@corp.com";
    mock.state.prefillSubject = "Hi";
    render(<ComposeEmailModal />);
    fireEvent.click(screen.getByText("Add follow-ups"));
    // Empty planner offers both AI and manual entry.
    expect(screen.getByText("Generate with AI")).toBeTruthy();
    fireEvent.click(screen.getByText("Add follow-up"));
    // A step card renders with its projected 9:05 AM send time.
    expect(screen.getAllByText(/9:05\s*AM/).length).toBeGreaterThan(0);
    // Once a step exists, the empty-state AI prompt is gone.
    expect(screen.queryByText("Generate with AI")).toBeNull();
  });
});
