// @vitest-environment jsdom
/**
 * The admin contacts card's cross-request state hazards (CAR-208 review).
 *
 * The PR that added `submittingRef` here shipped with no test, and the claim it
 * shipped with ("double-clicking Add created two contact rows") turned out not
 * to reproduce: `Button` renders `disabled={disabled || loading}`, both submit
 * call sites pass `loading={busy}`, React commits a discrete click update before
 * the browser dispatches the next click, and a disabled control has its queued
 * clicks discarded. So these tests deliberately do NOT assert a double click.
 * Two dispatches in one task is what `fireEvent.click` twice produces, not what
 * a user produces, and asserting on it would pin the simulation rather than the
 * behaviour.
 *
 * What IS asserted is the class of bug that survived that analysis: state torn
 * down by work that outlived the thing that started it. Both submits call
 * `close()` on their success path and the inject route runs under a 35s budget,
 * so an unscoped teardown reached across into whatever dialog was open when the
 * response finally landed; and the deferred delete's Undo toast outlives this
 * component, because ToastProvider is mounted in the root layout.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { mockToastModule, toastMock } from "./helpers/mock-toast";
import ContactsSection from "@/components/admin/contacts-section";

vi.mock("@/components/ui/toast", () => mockToastModule());

/** Toast ids handed out by `toast()`, so `dismiss()` can be matched against them. */
let nextToastId = 0;
const dismissed: string[] = [];

/** Requests parked until the test chooses to land them. */
let pending: Array<{ url: string; resolve: (v: unknown) => void }> = [];
let listRows: Array<Record<string, unknown>> = [];

vi.mock("@/lib/api-client", () => ({
  apiFetch: (url: string, init?: unknown) => {
    // The card's own list load settles immediately; everything else parks.
    // Keyed on the INIT, not the URL: the bundle inject POSTs to the same
    // `/contacts` path the list GETs from, and only the init tells them apart.
    if (!init && /\/contacts(\?|$)/.test(url)) {
      return Promise.resolve({ contacts: listRows, total: listRows.length });
    }
    return new Promise((resolve) => pending.push({ url, resolve }));
  },
  apiSend: (url: string) => new Promise((resolve) => pending.push({ url, resolve })),
  jsonBody: (body: unknown) => ({ method: "POST", body }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  dismissed.length = 0;
  pending = [];
  nextToastId = 0;
  listRows = [];
  toastMock.toast.mockImplementation(() => `t${nextToastId++}`);
  toastMock.dismiss.mockImplementation((id: string) => {
    dismissed.push(id);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Land the first parked request whose URL matches. */
async function settle(match: string, value: unknown = {}) {
  const hit = pending.find((p) => p.url.includes(match));
  if (!hit) {
    throw new Error(`no in-flight request matching "${match}"; have: ${pending.map((p) => p.url).join(", ") || "(none)"}`);
  }
  pending.splice(pending.indexOf(hit), 1);
  await act(async () => {
    hit.resolve(value);
  });
}

/** Flush the 250ms debounce on the list load. */
async function settleList() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
}

describe("a submit that outlives its own modal", () => {
  it("leaves the Add form alone when a stale bundle inject finally resolves", async () => {
    render(<ContactsSection userId="u1" />);
    await settleList();

    // Start a bundle inject.
    fireEvent.click(screen.getByRole("button", { name: /Inject bundle/i }));
    await settle("bundle-access", {
      bundles: [{ bundleId: "b1", name: "Q3 Seed", prospectCount: 250 }],
    });
    fireEvent.click(screen.getByText("Q3 Seed"));
    fireEvent.click(screen.getByRole("button", { name: "Inject 250 contacts" }));

    // The admin dismisses it and starts adding a contact by hand instead.
    fireEvent.click(screen.getByRole("button", { name: /^Add contact$/i }));
    const nameField = screen.getByPlaceholderText("Full name") as HTMLInputElement;
    fireEvent.change(nameField, { target: { value: "Jane Doe" } });
    expect(nameField.value).toBe("Jane Doe");

    // …and only now does the inject come back. Unscoped, its `close()` closed
    // this dialog and blanked all three fields.
    await settle("/contacts", { applied: 180, completed: false });

    const after = screen.getByPlaceholderText("Full name") as HTMLInputElement;
    expect(after.value).toBe("Jane Doe");
  });
});

describe("the deferred delete's undo affordance", () => {
  it("retracts the Undo toast on unmount, since the flush has already deleted", async () => {
    listRows = [
      {
        id: 42,
        name: "Jane Doe",
        linkedinUrl: null,
        networkStatus: "active",
        createdAt: "2026-01-01T00:00:00Z",
        email: null,
        title: null,
        company: null,
      },
    ];
    const { unmount } = render(<ContactsSection userId="u1" />);
    await settleList();

    // Remove the row: the delete is deferred behind a 5s undo window.
    fireEvent.click(screen.getByTitle("Remove Jane Doe"));
    expect(dismissed).toEqual([]);

    // Navigating away flushes the delete early. The toast lives in the root
    // layout and survives, so the Undo it still renders can no longer be
    // honoured — clicking it found no pending entry and dismissed itself,
    // indistinguishable from a successful undo with the row already gone.
    await act(async () => {
      unmount();
    });

    expect(dismissed).toEqual(["t0"]);
  });
});
