// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

/**
 * CAR-145 / F23: the compose body is remounted with key={composeSessionId} on
 * every open, so every field resets by construction. Opening for a new
 * recipient after drafting for another must leak nothing — subject, an opened
 * schedule picker, or the AI-draft banner.
 */

const mock = vi.hoisted(() => {
  const defaults = {
    isOpen: true,
    composeSessionId: 1,
    prefillTo: "",
    prefillName: "",
    prefillSubject: "",
    prefillBodyHtml: "",
    replyThreadId: "",
    replyInReplyTo: "",
    replyReferences: "",
    replyQuotedHtml: "",
    aiDraftContext: null as Record<string, unknown> | null,
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
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ user: { id: "u-1" } }) }));
vi.mock("@/hooks/use-capabilities", () => ({
  useCapabilities: () => ({ capabilities: new Set(), loading: false, can: () => true, refresh: async () => {} }),
}));
vi.mock("@/components/ui/rich-text-editor", () => ({ RichTextEditor: () => <div data-testid="rte" /> }));
vi.mock("@/components/ai-write-dropdown", () => ({ AiWriteDropdown: () => <div /> }));
vi.mock("@/components/availability-picker", () => ({ AvailabilityPicker: () => <div /> }));
vi.mock("@/components/intro-context-form", () => ({ IntroContextForm: () => <div /> }));
vi.mock("@/lib/queries", () => ({ getEmailProvenance: async () => null, markEmailVerified: async () => {} }));
vi.mock("@/lib/analytics/client", () => ({ track: () => {} }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: () => "", dismiss: () => {}, success: () => {}, error: () => {}, info: () => {}, warning: () => {} }),
}));

import { ComposeEmailModal } from "@/components/compose-email-modal";

function resetState() {
  Object.assign(mock.state, mock.defaults, { closeCompose: () => {}, openCompose: () => {} });
}

describe("ComposeEmailModal — keyed remount clears state between opens (CAR-145 / F23)", () => {
  beforeEach(() => {
    resetState();
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
  });
  afterEach(() => cleanup());

  it("does not leak the typed subject or an open schedule picker to the next recipient", () => {
    mock.state.composeSessionId = 1;
    mock.state.prefillSubject = "Hi Blair";
    const { rerender } = render(<ComposeEmailModal />);

    const subject = screen.getByPlaceholderText("Subject") as HTMLInputElement;
    expect(subject.value).toBe("Hi Blair");
    fireEvent.change(subject, { target: { value: "Coffee next week?" } });
    fireEvent.click(screen.getByText("Schedule"));
    expect(screen.getByText("Schedule send")).toBeTruthy();

    // Reopen for a different recipient: new session id + new prefill.
    mock.state.composeSessionId = 2;
    mock.state.prefillSubject = "Hi Avery";
    rerender(<ComposeEmailModal />);

    const subjectAfter = screen.getByPlaceholderText("Subject") as HTMLInputElement;
    expect(subjectAfter.value).toBe("Hi Avery");
    expect(screen.queryByText("Schedule send")).toBeNull();
    expect(screen.getByText("Schedule")).toBeTruthy();
  });

  it("does not leak the AI-draft banner to a plain compose", () => {
    mock.state.composeSessionId = 1;
    mock.state.aiDraftContext = { draftId: 7, extractedTopic: "their new role", topicEvidence: "…" };
    const { rerender } = render(<ComposeEmailModal />);
    expect(screen.getByText(/AI draft:/)).toBeTruthy();

    mock.state.composeSessionId = 2;
    mock.state.aiDraftContext = null;
    rerender(<ComposeEmailModal />);
    expect(screen.queryByText(/AI draft:/)).toBeNull();
  });
});
