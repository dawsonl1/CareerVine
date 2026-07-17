// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";

/**
 * CAR-145 / F42 + F21: the composer is hardened against a double-submit, a
 * ghost draft left behind by an autosave that resolves after the send, and a
 * silently-dropped follow-up failure.
 */

const h = vi.hoisted(() => ({ toastSpy: vi.fn() }));

const mock = vi.hoisted(() => {
  const defaults = {
    isOpen: true,
    composeSessionId: 1,
    prefillTo: "jane@corp.com",
    prefillName: "",
    prefillSubject: "Coffee?",
    prefillBodyHtml: "",
    replyThreadId: "",
    replyInReplyTo: "",
    replyReferences: "",
    replyQuotedHtml: "",
    aiDraftContext: null,
    existingDraftId: null,
    isIntro: false,
    contactId: 0,
    templateFollowUps: null as Array<{ subject: string; bodyHtml: string; delayDays: number }> | null,
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
  useToast: () => ({ toast: h.toastSpy, dismiss: () => {}, success: () => {}, error: () => {}, info: () => {}, warning: () => {} }),
}));

import { ComposeEmailModal } from "@/components/compose-email-modal";

function resetState() {
  Object.assign(mock.state, mock.defaults, { closeCompose: () => {}, openCompose: () => {} });
}

function sendButton() {
  return screen.getByText("Send").closest("button") as HTMLButtonElement;
}

describe("ComposeEmailModal — send guards (CAR-145 / F42 + F21)", () => {
  beforeEach(() => {
    resetState();
    h.toastSpy.mockClear();
  });
  afterEach(() => cleanup());

  it("dispatches a single send POST even when Send is double-clicked", async () => {
    const calls: string[] = [];
    global.fetch = vi.fn(async (url: string) => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ messageId: "m1", threadId: "t1" }) };
    }) as unknown as typeof fetch;

    render(<ComposeEmailModal />);
    await act(async () => {
      const btn = sendButton();
      fireEvent.click(btn);
      fireEvent.click(btn);
    });

    expect(calls.filter((u) => u.includes("/api/gmail/send")).length).toBe(1);
  });

  it("deletes the ghost draft when an autosave resolves after the send", async () => {
    let resolveDraft!: (v: unknown) => void;
    const draftInFlight = new Promise((r) => {
      resolveDraft = r;
    });
    const calls: string[] = [];
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      const u = String(url);
      const method = opts?.method ?? "GET";
      calls.push(`${method} ${u}`);
      if (u === "/api/gmail/drafts" && method === "POST") return draftInFlight;
      if (u === "/api/gmail/send") return { ok: true, json: async () => ({ messageId: "m1", threadId: "t1" }) };
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;

    render(<ComposeEmailModal />);

    // Kick off an in-flight draft save (the POST stays pending).
    fireEvent.click(screen.getByText("Save draft"));
    // Send completes first, marking the compose sent/scheduled.
    await act(async () => {
      fireEvent.click(sendButton());
    });
    // The autosave finally resolves — after the send already ran.
    await act(async () => {
      resolveDraft({ ok: true, json: async () => ({ draft: { id: 99 } }) });
    });

    // The draft it created is deleted, not left dangling as a ghost row.
    expect(calls).toContain("DELETE /api/gmail/drafts/99");
  });

  it("toasts a retry when follow-up scheduling fails after a successful send", async () => {
    mock.state.isIntro = true;
    mock.state.contactId = 5;
    mock.state.templateFollowUps = [{ subject: "Bump", bodyHtml: "<p>hi</p>", delayDays: 3 }];

    global.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u === "/api/email-follow-ups") return { ok: false, status: 500, json: async () => ({}) };
      if (u === "/api/gmail/send") return { ok: true, json: async () => ({ messageId: "m1", threadId: "t1" }) };
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;

    render(<ComposeEmailModal />);
    await act(async () => {
      fireEvent.click(sendButton());
    });

    expect(h.toastSpy).toHaveBeenCalledWith(
      "Email sent, but follow-ups could not be scheduled",
      expect.objectContaining({ variant: "error", actions: expect.any(Array) }),
    );
  });
});
