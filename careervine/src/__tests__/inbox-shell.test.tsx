// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, act } from "@testing-library/react";
import { UI_EVENTS, onUiEvent, type UnreadChangedDetail } from "@/lib/ui-events";

/**
 * CAR-150: behavioral tests against the REAL InboxShell (the prior suite mocked
 * it to a stub div). These lock the expansion invariant, the optimistic-mutation
 * contract, and the nav-badge event so the reducer extraction and the tab-child
 * decomposition can't silently regress them.
 */

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const openCompose = vi.hoisted(() => vi.fn());

vi.mock("@/components/navigation", () => ({ __esModule: true, default: () => <nav /> }));
vi.mock("@/components/oauth-warning", () => ({ OAuthWarning: () => <div /> }));
vi.mock("@/components/follow-up-modal", () => ({
  FollowUpModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div role="dialog" aria-label="Edit follow-ups" /> : null,
}));
// Stable user reference so the load effect doesn't re-run every render.
vi.mock("@/components/auth-provider", () => {
  const user = { id: "u-1" };
  return { useAuth: () => ({ user }) };
});
vi.mock("@/components/compose-email-context", () => ({
  useCompose: () => ({ gmailConnected: true, gmailLoading: false, openCompose }),
}));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({
    error: toast.error,
    success: toast.success,
    info: vi.fn(),
    warning: vi.fn(),
    toast: vi.fn(),
    dismiss: vi.fn(),
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/gmail-sync-client", () => ({ runFullGmailSync: vi.fn(async () => {}) }));
vi.mock("@/lib/analytics/client", () => ({ trackBeforeNavigate: vi.fn() }));

import { InboxShell } from "@/components/email/inbox/inbox-shell";

// ── Fixtures ──────────────────────────────────────────────────────────────

type Email = Record<string, unknown>;
function makeEmail(over: Email = {}): Email {
  return {
    gmail_message_id: "m1",
    thread_id: "t1",
    subject: "Coffee chat",
    direction: "inbound",
    from_address: "jane@corp.com",
    to_addresses: ["me@gmail.com"],
    date: "2026-07-10T12:00:00Z",
    matched_contact_id: null,
    snippet: "jane-snippet",
    is_read: false,
    is_trashed: false,
    is_hidden: false,
    ...over,
  };
}

function inboxPayload(over: Record<string, unknown> = {}) {
  return {
    success: true,
    emails: [],
    trashedEmails: [],
    hiddenEmails: [],
    scheduledEmails: [],
    followUps: [],
    contactMap: {},
    calendarByThread: {},
    gmailAddress: "me@gmail.com",
    ...over,
  };
}

// Per-test fetch routing. `bodyFor` overrides the expanded-body response by id;
// `trashStatus` lets a test force a failed mutation.
type FetchCfg = {
  inbox: Record<string, unknown>;
  drafts?: { drafts: unknown[] };
  bodyFor?: (id: string) => Promise<unknown> | { ok: boolean; json: () => Promise<unknown> };
  mutationOk?: boolean;
};

function installFetch(cfg: FetchCfg) {
  const drafts = cfg.drafts ?? { drafts: [] };
  global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = typeof url === "string" ? url : url.toString();
    const method = init?.method ?? "GET";
    // Mutations: trash/hide/move/read/draft-delete
    if (/\/api\/gmail\/emails\/[^/]+\/(trash|hide|move|read)$/.test(path) || (path.includes("/api/gmail/drafts/") && method === "DELETE")) {
      const ok = cfg.mutationOk ?? true;
      return { ok, status: ok ? 200 : 500, json: async () => ({ success: ok }) };
    }
    // Expanded body: /api/gmail/emails/:id (GET, no trailing action)
    const bodyMatch = path.match(/\/api\/gmail\/emails\/([^/]+)$/);
    if (bodyMatch && method === "GET" && cfg.bodyFor) {
      return cfg.bodyFor(bodyMatch[1]);
    }
    if (path.includes("/api/gmail/drafts")) return { ok: true, json: async () => drafts };
    if (path.includes("/api/gmail/labels")) return { ok: true, json: async () => ({ labels: [] }) };
    return { ok: true, json: async () => cfg.inbox };
  }) as unknown as typeof fetch;
}

/** Collect nav-badge events through the typed bus (keeps the raw literal out of tests). */
function collectUnread() {
  const events: (UnreadChangedDetail | undefined)[] = [];
  const off = onUiEvent(UI_EVENTS.unreadChanged, (d) => events.push(d));
  return { events, off };
}

/** Open a thread row's 3-dot action menu (single-thread fixtures only). */
function openActionMenu() {
  fireEvent.click(screen.getByTitle("Actions"));
}

/**
 * Click a thread-action-menu item by name. "Trash" also names the sidebar/mobile
 * tab buttons, so target the last match — the menu is deepest in DOM order.
 */
function clickMenuItem(name: string | RegExp) {
  const btns = screen.getAllByRole("button", { name });
  fireEvent.click(btns[btns.length - 1]);
}

beforeEach(() => {
  toast.error.mockClear();
  toast.success.mockClear();
  openCompose.mockClear();
});
afterEach(() => cleanup());

describe("InboxShell — expansion", () => {
  it("expands a single-message thread and renders the fetched body", async () => {
    installFetch({
      inbox: inboxPayload({ emails: [makeEmail({ is_read: true })] }),
      bodyFor: async () => ({
        ok: true,
        json: async () => ({ success: true, message: { subject: "Coffee chat", from: "jane@corp.com", to: "me@gmail.com", date: "2026-07-10T12:00:00Z", bodyHtml: "<p>Body of the message</p>", bodyText: "", messageId: "m1", threadId: "t1" } }),
      }),
    });
    render(<InboxShell />);
    await waitFor(() => expect(screen.getByText("Coffee chat")).toBeTruthy());

    expect(screen.queryByText("Body of the message")).toBeNull();
    fireEvent.click(screen.getByText("Coffee chat"));
    await waitFor(() => expect(screen.getByText("Body of the message")).toBeTruthy());
  });

  it("collapses expansion when switching tabs and back", async () => {
    installFetch({
      inbox: inboxPayload({ emails: [makeEmail({ is_read: true })] }),
      bodyFor: async () => ({ ok: true, json: async () => ({ success: true, message: { subject: "Coffee chat", from: "jane@corp.com", to: "me@gmail.com", date: "2026-07-10T12:00:00Z", bodyHtml: "<p>Body of the message</p>", bodyText: "", messageId: "m1", threadId: "t1" } }) }),
    });
    render(<InboxShell />);
    await waitFor(() => expect(screen.getByText("Coffee chat")).toBeTruthy());

    fireEvent.click(screen.getByText("Coffee chat"));
    await waitFor(() => expect(screen.getByText("Body of the message")).toBeTruthy());

    // Switch away then back — collapseAll() on tab change must reset expansion.
    fireEvent.click(screen.getAllByRole("button", { name: /Scheduled/ })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: /^Inbox/ })[0]);
    expect(screen.getByText("Coffee chat")).toBeTruthy();
    expect(screen.queryByText("Body of the message")).toBeNull();
  });

  it("drops a stale slower body fetch so it can't overwrite a newer expansion (F19)", async () => {
    let resolveM1!: (v: unknown) => void;
    const m1Body = new Promise((r) => { resolveM1 = r; });
    installFetch({
      inbox: inboxPayload({
        emails: [
          makeEmail({ gmail_message_id: "m1", is_read: true, from_address: "alice1@x.com", snippet: "alpha-snippet", date: "2026-07-01T10:00:00Z" }),
          makeEmail({ gmail_message_id: "m2", is_read: true, from_address: "bravo2@x.com", snippet: "bravo-snippet", date: "2026-07-02T10:00:00Z" }),
        ],
      }),
      bodyFor: (id) =>
        id === "m1"
          ? (m1Body as Promise<{ ok: boolean; json: () => Promise<unknown> }>)
          : { ok: true, json: async () => ({ success: true, message: { subject: "s", from: "bravo2@x.com", to: "me@gmail.com", date: "2026-07-02T10:00:00Z", bodyHtml: "<p>BODY-M2</p>", bodyText: "", messageId: "m2", threadId: "t1" } }) },
    });
    render(<InboxShell />);
    await waitFor(() => expect(screen.getByText("Coffee chat")).toBeTruthy());

    // Open the multi-message thread, then expand m1 (its body fetch hangs).
    fireEvent.click(screen.getByText("Coffee chat"));
    await act(async () => {
      fireEvent.click(screen.getByText("alpha-snippet"));
    });
    // Expand m2 while m1 is still in flight; m2 resolves and wins.
    await act(async () => {
      fireEvent.click(screen.getAllByText("bravo-snippet")[1]);
    });
    await waitFor(() => expect(screen.getByText("BODY-M2")).toBeTruthy());

    // m1's slower response finally arrives — the latest-request guard drops it.
    await act(async () => {
      resolveM1({ ok: true, json: async () => ({ success: true, message: { subject: "s", from: "alice1@x.com", to: "me@gmail.com", date: "2026-07-01T10:00:00Z", bodyHtml: "<p>BODY-M1</p>", bodyText: "", messageId: "m1", threadId: "t1" } }) });
    });
    expect(screen.queryByText("BODY-M1")).toBeNull();
    expect(screen.getByText("BODY-M2")).toBeTruthy();
  });
});

describe("InboxShell — optimistic mutations + nav badge", () => {
  it("trashes an unread inbound email: it leaves the list and decrements the badge", async () => {
    installFetch({ inbox: inboxPayload({ emails: [makeEmail()] }) });
    render(<InboxShell />);
    await waitFor(() => expect(screen.getByText("Coffee chat")).toBeTruthy());

    const { events, off } = collectUnread();
    openActionMenu();
    clickMenuItem("Trash");

    await waitFor(() => expect(screen.queryByText("Coffee chat")).toBeNull());
    expect(events.some((d) => d?.delta === -1)).toBe(true);
    off();
  });

  it("restoring an unread inbound email from trash increments the badge (F18 fix)", async () => {
    installFetch({ inbox: inboxPayload({ trashedEmails: [makeEmail({ gmail_message_id: "m9", subject: "Trashed note", is_trashed: true })] }) });
    render(<InboxShell />);
    // No inbox mail — wait for the load to settle on the empty-inbox state.
    await waitFor(() => expect(screen.getByText("No emails synced yet.")).toBeTruthy());
    // Go to the Trash tab.
    fireEvent.click(screen.getAllByRole("button", { name: /^Trash/ })[0]);
    await waitFor(() => expect(screen.getByText("Trashed note")).toBeTruthy());

    const { events, off } = collectUnread();
    openActionMenu();
    clickMenuItem("Restore");

    await waitFor(() => expect(screen.queryByText("Trashed note")).toBeNull());
    expect(events.some((d) => d?.delta === 1)).toBe(true);
    off();
  });

  it("rolls the email back into the list and toasts when the trash request fails (F21)", async () => {
    installFetch({ inbox: inboxPayload({ emails: [makeEmail()] }), mutationOk: false });
    render(<InboxShell />);
    await waitFor(() => expect(screen.getByText("Coffee chat")).toBeTruthy());

    openActionMenu();
    clickMenuItem("Trash");

    // Optimistically removed, then the failed request restores it and toasts.
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByText("Coffee chat")).toBeTruthy();
  });
});
