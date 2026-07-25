// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { installFakeFetch } from "./helpers/fake-fetch";
import { mockToastModule, toastMock } from "./helpers/mock-toast";
import { mockAuthProviderModule } from "./helpers/mock-auth-provider";

/**
 * The CAR-188 contract, asserted on components that had no test at all before
 * it. Two claims per surface, and they are the two the sweep exists to make
 * true:
 *
 *   1. a non-ok response leaves state unchanged and surfaces a toast
 *   2. a failed load renders the retryable error state, not the empty state
 *
 * Claim 2 is the one worth the trouble. An empty state is an affirmative
 * statement about the user's data ("No email history found.", "you have no key
 * on file"), and rendering it over a 500 does not merely hide an error, it
 * produces a confident lie the user then acts on: writing a cold intro to
 * someone they have been emailing for months, or pasting a replacement API key
 * over one that was there all along.
 *
 * Every case routes through `installFakeFetch` rather than an `{ ok, json }`
 * literal, because these handlers now go through `apiSend`, whose failure path
 * reads `res.status` AND `res.json()` (CONVENTIONS.md §h). `unmatched` is
 * asserted empty wherever a test's conclusion could otherwise be produced by a
 * mis-stubbed URL: the handlers under test swallow rejections by design, so a
 * wrong URL would masquerade as the failure the test was written to prove.
 * (CAR-188's version of this docblock said "throughout" and three cases did
 * not; they assert it now, so the claim and the file agree — CAR-204.)
 */

vi.mock("@/components/ui/toast", () => mockToastModule());
vi.mock("@/components/auth-provider", () => mockAuthProviderModule());

import ProviderKeyCard, { type ProviderKeyCardConfig } from "@/components/settings/provider-key-card";
import { ContactEmailsTab } from "@/components/contacts/contact-emails-tab";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => vi.clearAllMocks());

// ── ProviderKeyCard ──────────────────────────────────────────────────────

const KEY_ROUTE = "GET /api/settings/openai-key";
const REMOVE_CONFIRM = "Remove your OpenAI key? CareerVine will stop drafting with it.";

const keyConfig: ProviderKeyCardConfig = {
  inputId: "openai-api-key",
  endpoint: "/api/settings/openai-key",
  title: "OpenAI API key",
  icon: null,
  badgeLabel: "OpenAI key",
  placeholder: "sk-...",
  intro: "Bring your own key.",
  steps: null,
  removeConfirm: REMOVE_CONFIRM,
  emptyKeyError: "Paste a key first.",
  dataNote: "Encrypted at rest.",
  problemBanner: () => "There is a problem with this key.",
};

const storedKey = { hasKey: true, last4: "abcd", status: "active" as const };

async function renderKeyCard(route: Parameters<typeof installFakeFetch>[0][string]) {
  const http = installFakeFetch({ [KEY_ROUTE]: route });
  await act(async () => {
    render(<ProviderKeyCard config={keyConfig} />);
  });
  return http;
}

describe("ProviderKeyCard — failed status load (CAR-188)", () => {
  it("offers a retry instead of rendering the no-key form", async () => {
    // Unchecked, the `{ error }` body was assigned straight to `status`, where
    // `hasKey` reads undefined. The card then rendered its "API key" form, and
    // a user who pasted into it would overwrite a key that was still there.
    const http = await renderKeyCard({ status: 500, body: { error: "boom" } });

    expect(screen.getByText("Couldn't load your key status.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    // The form is withheld entirely, which is the overwrite guard.
    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(screen.queryByLabelText("Replace key")).toBeNull();
    expect(http.unmatched).toEqual([]);
  });

  it("recovers the stored-key badge when Retry succeeds", async () => {
    await renderKeyCard({ status: 500, body: {} });
    expect(screen.getByText("Couldn't load your key status.")).toBeTruthy();

    const second = installFakeFetch({ [KEY_ROUTE]: { body: storedKey } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });

    expect(screen.queryByText("Couldn't load your key status.")).toBeNull();
    expect(screen.getByText(/abcd/)).toBeTruthy();
    expect(second.countOf(KEY_ROUTE)).toBe(1);
  });
});

describe("ProviderKeyCard — remove (CAR-188)", () => {
  async function clickRemove(deleteRoute: Parameters<typeof installFakeFetch>[0][string]) {
    const http = installFakeFetch({
      [KEY_ROUTE]: { body: storedKey },
      "DELETE /api/settings/openai-key": deleteRoute,
    });
    await act(async () => {
      render(<ProviderKeyCard config={keyConfig} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    });
    return http;
  }

  it("asks first, using the provider's own config-driven copy", async () => {
    // The one confirm of the twelve whose message is not a string literal, and
    // the reason ConfirmDialog takes a `message` prop at all.
    const http = await clickRemove({ body: {} });
    expect(screen.getByText(REMOVE_CONFIRM)).toBeTruthy();
    expect(http.unmatched).toEqual([]);
  });

  it("keeps the key and reports the route's reason when the delete fails", async () => {
    const http = await clickRemove({ status: 500, body: { error: "Key store unavailable" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    });

    // Still on file: the badge is the state that must not move.
    expect(screen.getByText(/abcd/)).toBeTruthy();
    // The endpoint validates against the provider, so its message is the
    // actionable part and this is one of the few sites that surfaces it.
    expect(screen.getByText("Key store unavailable")).toBeTruthy();
    expect(http.countOf("DELETE /api/settings/openai-key")).toBe(1);
    expect(http.unmatched).toEqual([]);
  });

  it("does not call the route at all when the user declines", async () => {
    const http = await clickRemove({ body: {} });
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));
    });

    expect(screen.getByText(/abcd/)).toBeTruthy();
    expect(http.countOf("DELETE /api/settings/openai-key")).toBe(0);
  });
});

// ── ContactEmailsTab ─────────────────────────────────────────────────────

const FOLLOW_UPS_ROUTE = "GET /api/gmail/follow-ups";

function renderEmailsTab(
  overrides: { emailsLoadFailed?: boolean; scheduledLoadFailed?: boolean } = {},
) {
  return render(
    <ContactEmailsTab
      contactId={7}
      contactName="Ada Lovelace"
      contactEmails={["ada@example.com"]}
      emails={[]}
      scheduledEmails={[]}
      gmailConnected
      canReadMailbox
      loadingEmails={false}
      emailsLoadFailed={false}
      scheduledLoadFailed={false}
      onScheduledEmailCancel={vi.fn()}
      onReloadEmails={vi.fn()}
      {...overrides}
    />,
  );
}

vi.mock("@/components/compose-email-context", () => ({
  useCompose: () => ({ openCompose: vi.fn() }),
}));

describe("ContactEmailsTab — failed load (CAR-188)", () => {
  it("offers a retry instead of claiming the contact has no email history", async () => {
    // "No email history found." over a failed read is the lie this guards: the
    // user writes a cold intro to someone they have been corresponding with.
    const http = installFakeFetch({ [FOLLOW_UPS_ROUTE]: { body: { followUps: [] } } });
    await act(async () => {
      renderEmailsTab({ emailsLoadFailed: true });
    });

    expect(screen.queryByText("No email history found.")).toBeNull();
    expect(screen.getByText("Couldn't load this contact's email history.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(http.unmatched).toEqual([]);
  });

  it("shows the empty state when the load genuinely succeeded and found nothing", async () => {
    const http = installFakeFetch({ [FOLLOW_UPS_ROUTE]: { body: { followUps: [] } } });
    await act(async () => {
      renderEmailsTab();
    });

    expect(screen.getByText("No email history found.")).toBeTruthy();
    expect(screen.queryByText("Couldn't load this contact's email history.")).toBeNull();
    expect(http.unmatched).toEqual([]);
  });

  /**
   * CAR-188 read the two contact-email endpoints through `Promise.all`, so a
   * failed SCHEDULED read rejected the pair and discarded a successful EMAIL
   * read. The banner then claimed the email history could not load, which was
   * false, and the Timeline tab (fed by the same `contactEmails` state, with no
   * failure prop of its own) silently rendered a relationship history with every
   * email missing. The two now settle independently (CAR-204).
   */
  it("keeps the email list when only the scheduled read fails, and says so separately", async () => {
    const http = installFakeFetch({ [FOLLOW_UPS_ROUTE]: { body: { followUps: [] } } });
    await act(async () => {
      renderEmailsTab({ emailsLoadFailed: false, scheduledLoadFailed: true });
    });

    // The email surface is intact and makes no false claim about itself.
    expect(screen.queryByText("Couldn't load this contact's email history.")).toBeNull();
    // The failure that DID happen is reported, on its own surface.
    expect(screen.getByText("Couldn't load scheduled sends for this contact.")).toBeTruthy();
    expect(http.unmatched).toEqual([]);
  });

  /**
   * The follow-up chips are the one read in this component that is allowed to
   * fail quietly, and the `// error-tolerated:` comment on it says why. This
   * pins that the tolerance is scoped to the chips and does not leak into the
   * emails themselves, whose failure the parent owns.
   */
  it("still renders the email surface when the follow-up chips fail to load", async () => {
    const http = installFakeFetch({ [FOLLOW_UPS_ROUTE]: { status: 500, body: { error: "boom" } } });
    await act(async () => {
      renderEmailsTab();
    });

    expect(screen.getByText("No email history found.")).toBeTruthy();
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(http.countOf(FOLLOW_UPS_ROUTE)).toBe(1);
    expect(http.unmatched).toEqual([]);
  });
});
