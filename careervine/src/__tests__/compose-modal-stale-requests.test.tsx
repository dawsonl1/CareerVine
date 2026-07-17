// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";

/**
 * CAR-145 / F19 (deep-review follow-up): the latest-request guard must also
 * invalidate in-flight requests on the "clear" paths. Clearing the recipient
 * field (empty autocomplete query, or a non-email value) must drop a slower
 * response so it can't repopulate suggestions / a provenance banner over a
 * field the user already changed. Both tests fail if `begin()` is not claimed
 * before the early return.
 */

type ProvMeta = { id: number; source: string; bounced_at: string | null } | null;
const h = vi.hoisted(() => ({
  provenanceFn: vi.fn(async (_email: string): Promise<ProvMeta> => null),
}));

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
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ user: { id: "u-1" } }) }));
vi.mock("@/hooks/use-capabilities", () => ({
  useCapabilities: () => ({ capabilities: new Set(), loading: false, can: () => true, refresh: async () => {} }),
}));
vi.mock("@/components/ui/rich-text-editor", () => ({ RichTextEditor: () => <div data-testid="rte" /> }));
vi.mock("@/components/ai-write-dropdown", () => ({ AiWriteDropdown: () => <div /> }));
vi.mock("@/components/availability-picker", () => ({ AvailabilityPicker: () => <div /> }));
vi.mock("@/components/intro-context-form", () => ({ IntroContextForm: () => <div /> }));
vi.mock("@/lib/queries", () => ({
  getEmailProvenance: (email: string) => h.provenanceFn(email),
  markEmailVerified: async () => {},
}));
vi.mock("@/lib/analytics/client", () => ({ track: () => {} }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: () => "", dismiss: () => {}, success: () => {}, error: () => {}, info: () => {}, warning: () => {} }),
}));

import { ComposeEmailModal } from "@/components/compose-email-modal";

function resetState() {
  Object.assign(mock.state, mock.defaults, { closeCompose: () => {}, openCompose: () => {} });
}

describe("ComposeEmailModal — stale-request guards on clear paths (CAR-145 / F19)", () => {
  beforeEach(() => {
    resetState();
    h.provenanceFn.mockReset();
    h.provenanceFn.mockResolvedValue(null);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("drops a slower contact search that resolves after the field is cleared", async () => {
    let resolveJo!: (v: unknown) => void;
    const joFetch = new Promise((r) => {
      resolveJo = r;
    });
    global.fetch = vi.fn((url: string) => {
      const u = String(url);
      if (u.includes("/api/contacts/search")) {
        if (u.includes("q=jo")) return joFetch;
        return Promise.resolve({ ok: true, json: async () => ({ contacts: [] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }) as unknown as typeof fetch;

    render(<ComposeEmailModal />);
    const to = screen.getByPlaceholderText(/Name or email/);

    // Type "jo" → after the 200ms debounce the search fires (stays in flight).
    fireEvent.change(to, { target: { value: "jo" } });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    // Clear the field → after its debounce the empty-query path runs.
    fireEvent.change(to, { target: { value: "" } });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    // The earlier "jo" search finally resolves with results.
    await act(async () => {
      resolveJo({ ok: true, json: async () => ({ contacts: [{ id: 1, name: "Jo Smith", email: "jo@x.com", emails: ["jo@x.com"] }] }) });
    });

    // Stale suggestions must not appear under the now-empty field.
    expect(screen.queryByText("Jo Smith")).toBeNull();
  });

  it("drops a slower provenance lookup after the recipient becomes a non-email", async () => {
    let resolveProv!: (v: ProvMeta) => void;
    const provPromise = new Promise<ProvMeta>((r) => {
      resolveProv = r;
    });
    h.provenanceFn.mockImplementation((email: string) =>
      email === "a@x.com" ? provPromise : Promise.resolve(null),
    );
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ contacts: [] }) })) as unknown as typeof fetch;

    render(<ComposeEmailModal />);
    const to = screen.getByPlaceholderText(/Name or email/);

    // A valid email triggers a provenance lookup after the 300ms debounce.
    fireEvent.change(to, { target: { value: "a@x.com" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    // The user edits it to a non-email before the lookup returns.
    fireEvent.change(to, { target: { value: "john" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    // The lookup for the old address finally resolves as bounced.
    await act(async () => {
      resolveProv({ id: 1, source: "scraped", bounced_at: "2026-01-01T00:00:00Z" });
    });

    // The stale bounce banner must not attach to the address the field no longer holds.
    expect(screen.queryByText(/bounced/i)).toBeNull();
  });
});
