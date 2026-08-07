// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";

/**
 * CAR-277: the intro context form's answers are actually persisted.
 *
 * They were not. The composer sent them to `PATCH /api/contacts/[id]` and
 * `POST /api/contacts/[id]/note` — two routes that were never built — and both
 * calls were swallowed by an empty catch, so three questions the user answered
 * were dropped on every intro draft with nothing on screen to say so. They now
 * go through the contacts write chokepoint (CONVENTIONS d) like every other
 * client write in the app.
 *
 * The HTTP assertion is the half that keeps this fixed: `installFakeFetch`
 * records any unrouted request in `unmatched`, so a regression that reaches for
 * a `/api/contacts/...` URL again fails here instead of 404ing in silence.
 */

const h = vi.hoisted(() => ({
  updateContact: vi.fn(async () => null),
  appendContactNote: vi.fn(async () => {}),
}));

vi.mock("@/components/compose-email-context", () => ({ useCompose: () => mock.state }));
vi.mock("@/components/auth-provider", () => mockAuthProviderModule());
vi.mock("@/hooks/use-capabilities", () => ({
  useCapabilities: () => ({ capabilities: new Set(), loading: false, can: () => true, refresh: async () => {} }),
}));
vi.mock("@/components/ui/rich-text-editor", () => ({ RichTextEditor: () => <div data-testid="rte" /> }));
vi.mock("@/components/ai-write-dropdown", () => ({ AiWriteDropdown: () => <div /> }));
vi.mock("@/components/availability-picker", () => ({ AvailabilityPicker: () => <div /> }));
vi.mock("@/lib/queries", () => ({ getEmailProvenance: async () => null, markEmailVerified: async () => {} }));
// The real module is left unmocked in the sibling compose suites; here the two
// writes ARE the subject, so they are spied rather than executed.
vi.mock("@/lib/data/contacts", () => ({
  updateContact: h.updateContact,
  appendContactNote: h.appendContactNote,
}));
vi.mock("@/lib/analytics/client", () => mockAnalyticsClientModule({ track: () => {} }));
vi.mock("@/components/ui/toast", () => mockToastModule());

import { mockAnalyticsClientModule } from "./helpers/mock-analytics";
import { mockAuthProviderModule } from "./helpers/mock-auth-provider";
import { mockToastModule } from "./helpers/mock-toast";
import { installFakeFetch } from "./helpers/fake-fetch";
import { ComposeEmailModal } from "@/components/compose-email-modal";

const mock = vi.hoisted(() => {
  const defaults = {
    isOpen: true,
    composeSessionId: 1,
    prefillTo: "jane@corp.com",
    prefillName: "Jane",
    prefillSubject: "",
    prefillBodyHtml: "",
    replyThreadId: "",
    replyInReplyTo: "",
    replyReferences: "",
    replyQuotedHtml: "",
    aiDraftContext: null,
    existingDraftId: null,
    isIntro: true,
    contactId: 5,
    templateFollowUps: null as Array<{ subject: string; bodyHtml: string; delayDays: number }> | null,
    gmailAddress: "me@gmail.com",
    closeCompose: () => {},
    openCompose: () => {},
  };
  return { state: { ...defaults }, defaults };
});

const DRAFT_INTRO = "POST /api/ai/draft-intro";

/** Fill the intro form the way a user does, then press Generate draft. */
async function generateWithContext(opts: { notes?: string } = {}) {
  render(<ComposeEmailModal />);
  fireEvent.click(screen.getByText("Career fair"));
  fireEvent.click(screen.getByText("Set up a coffee chat"));
  if (opts.notes !== undefined) {
    fireEvent.change(
      screen.getByPlaceholderText("e.g., We talked about their PM internship program"),
      { target: { value: opts.notes } },
    );
  }
  await act(async () => {
    fireEvent.click(screen.getByText("Generate draft"));
  });
}

describe("ComposeEmailModal — the intro context is persisted (CAR-277)", () => {
  beforeEach(() => {
    Object.assign(mock.state, mock.defaults, { closeCompose: () => {}, openCompose: () => {} });
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("writes how-you-met and the goal to the contact, and the note separately", async () => {
    const http = installFakeFetch({
      [DRAFT_INTRO]: { body: { bodyHtml: "<p>hi</p>", subject: "Coffee?" } },
    });

    await generateWithContext({ notes: "They run the PM internship program" });

    expect(h.updateContact).toHaveBeenCalledWith(5, {
      met_through: "Career fair",
      intro_goal: "Set up a coffee chat",
    });
    expect(h.appendContactNote).toHaveBeenCalledWith(5, "They run the PM internship program");

    // The draft still happens, and it is the ONLY request made — in particular
    // nothing reaches for the two routes that never existed.
    expect(http.countOf(DRAFT_INTRO)).toBe(1);
    expect(http.unmatched).toEqual([]);
  });

  it("omits the note write when the optional field is left blank", async () => {
    installFakeFetch({ [DRAFT_INTRO]: { body: { bodyHtml: "<p>hi</p>" } } });

    await generateWithContext();

    expect(h.updateContact).toHaveBeenCalledTimes(1);
    expect(h.appendContactNote).not.toHaveBeenCalled();
  });

  it("never nulls out a field the user left empty", async () => {
    installFakeFetch({ [DRAFT_INTRO]: { body: { bodyHtml: "<p>hi</p>" } } });

    render(<ComposeEmailModal />);
    // Goal only. `met_through` must be ABSENT from the patch rather than null:
    // the form starts blank every time, so a blank answer is "no answer", not
    // "erase what you already knew about this contact".
    fireEvent.click(screen.getByText("Stay on their radar"));
    await act(async () => {
      fireEvent.click(screen.getByText("Generate draft"));
    });

    expect(h.updateContact).toHaveBeenCalledWith(5, { intro_goal: "Stay on their radar" });
  });

  it("writes the note once when Generate draft is double-clicked", async () => {
    const http = installFakeFetch({
      [DRAFT_INTRO]: { body: { bodyHtml: "<p>hi</p>", subject: "Coffee?" } },
    });

    render(<ComposeEmailModal />);
    fireEvent.click(screen.getByText("Career fair"));
    fireEvent.change(
      screen.getByPlaceholderText("e.g., We talked about their PM internship program"),
      { target: { value: "They run the PM internship program" } },
    );
    await act(async () => {
      const btn = screen.getByText("Generate draft");
      fireEvent.click(btn);
      fireEvent.click(btn);
    });

    // `appendContactNote` APPENDS, so a second pass would leave the user's note
    // on the contact twice. `introPhase` alone cannot stop it: both clicks land
    // before the state flip has rendered.
    expect(h.appendContactNote).toHaveBeenCalledTimes(1);
    expect(h.updateContact).toHaveBeenCalledTimes(1);
    expect(http.countOf(DRAFT_INTRO)).toBe(1);
  });

  it("still drafts when the context save fails", async () => {
    h.updateContact.mockRejectedValueOnce(new Error("rls"));
    const http = installFakeFetch({
      [DRAFT_INTRO]: { body: { bodyHtml: "<p>hi</p>", subject: "Coffee?" } },
    });

    await generateWithContext();

    // The draft is generated from the same values in its own request, so a
    // failed save costs the user nothing in this session (error-tolerated).
    expect(http.countOf(DRAFT_INTRO)).toBe(1);
    expect(http.unmatched).toEqual([]);
  });
});
