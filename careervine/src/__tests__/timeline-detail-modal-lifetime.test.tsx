// @vitest-environment jsdom
/**
 * CAR-249 — the timeline detail modal must OUTLIVE a background refresh.
 *
 * The contact page wraps its tabs in a `SectionBoundary` whose key is
 * `${activeTab}:${dataGeneration}`, and every completed `loadRelatedData` bumps
 * `dataGeneration` by design (CAR-184: it is what lets fresh data clear a stale
 * error panel). Anything mounted inside that boundary is therefore destroyed and
 * rebuilt whenever a refresh lands.
 *
 * CAR-204 already paid for this once: a `useConfirm` living in the timeline tab
 * had its open dialog vanish mid-question, with nothing deleted and nothing
 * said. The interaction edit form had the same bug and nobody noticed, because
 * losing a half-typed summary is silent.
 *
 * So the modal is rendered by the PAGE, outside the boundary. This test is the
 * guard on that placement, and it fails if the modal is moved back inside:
 * a remount resets the component's own state, which is where the edit form's
 * unsaved text lives.
 *
 * The modal is doubled ON PURPOSE. What is under test is the page's placement
 * decision, and the double can count its own mounts, which the real component
 * cannot report.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import { mockAuthProviderModule } from "./helpers/mock-auth-provider";
import { mockToastModule } from "./helpers/mock-toast";
import { UI_EVENTS, emitUiEvent } from "@/lib/ui-events";

const q = vi.hoisted(() => ({
  getContactById: vi.fn(),
  getContacts: vi.fn(),
  getMeetingsForContact: vi.fn(),
  getActionItemsForContact: vi.fn(),
  getCompletedActionItemsForContact: vi.fn(),
  getInteractions: vi.fn(),
  getAttachmentsForContact: vi.fn(),
  getGmailConnection: vi.fn(),
  deleteContact: vi.fn(),
}));

/** Bumped by the doubled modal every time it MOUNTS. */
const mounts = vi.hoisted(() => ({ count: 0 }));

vi.mock("@/lib/queries", () => q);
vi.mock("@/components/auth-provider", () => mockAuthProviderModule());
vi.mock("@/components/ui/toast", () => mockToastModule());
vi.mock("@/components/navigation", () => ({ __esModule: true, default: () => <nav /> }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "7" }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/components/compose-email-context", () => ({
  useCompose: () => ({ gmailConnected: false, gmailLoading: false, openCompose: vi.fn() }),
}));
vi.mock("@/components/quick-capture-context", () => ({
  useQuickCapture: () => ({ open: vi.fn(), openEdit: vi.fn() }),
}));
vi.mock("@/hooks/use-capabilities", () => ({
  useCapabilities: () => ({ can: () => true }),
}));

// The tab double's only job is to hand the page a row click.
vi.mock("@/components/contacts/contact-timeline-tab", () => ({
  ContactTimelineTab: ({ onEntryClick }: { onEntryClick: (e: unknown) => void }) => (
    <button onClick={() => onEntryClick({ kind: "meeting", date: "2026-06-28T14:00:00Z", data: { id: 42 } })}>
      row
    </button>
  ),
}));

vi.mock("@/components/contacts/timeline-detail-modal", async () => {
  const { useState } = await import("react");
  return {
    TimelineDetailModal: ({ entry }: { entry: unknown }) => {
      // A piece of component-local state, which is exactly what a remount
      // destroys (in the real component it is the interaction edit form). The
      // lazy initializer runs once per mount, so it doubles as the counter.
      const [local] = useState(() => `instance-${++mounts.count}`);
      return entry ? <p>detail open {local}</p> : null;
    },
  };
});

vi.mock("@/components/contacts/contact-actions-tab", () => ({ ContactActionsTab: () => <div /> }));
vi.mock("@/components/contacts/contact-attachments-tab", () => ({ ContactAttachmentsTab: () => <div /> }));
vi.mock("@/components/contacts/contact-emails-tab", () => ({ ContactEmailsTab: () => <div /> }));
vi.mock("@/components/contacts/contact-profile-card", () => ({ ContactProfileCard: () => <div /> }));
vi.mock("@/components/contacts/contact-about-card", () => ({ ContactAboutCard: () => <div /> }));
vi.mock("@/components/contacts/contact-experience-card", () => ({ ContactExperienceCard: () => <div /> }));
vi.mock("@/components/contacts/contact-follow-up-status", () => ({ ContactFollowUpStatus: () => <div /> }));
vi.mock("@/components/contacts/contact-quick-actions", () => ({ ContactQuickActions: () => <div /> }));
vi.mock("@/components/contacts/contact-edit-modal", () => ({ ContactEditModal: () => null }));
vi.mock("@/components/contacts/contact-pending-actions-banner", () => ({
  ContactPendingActionsBanner: () => null,
}));

import ContactDetailPage from "@/app/contacts/[id]/page";

beforeEach(() => {
  vi.clearAllMocks();
  mounts.count = 0;
  window.location.hash = "";
  q.getContactById.mockResolvedValue({
    id: 7,
    name: "Ada Lovelace",
    contact_emails: [],
    contact_companies: [],
  });
  q.getContacts.mockResolvedValue([]);
  q.getGmailConnection.mockResolvedValue(null);
  q.getMeetingsForContact.mockResolvedValue([]);
  q.getActionItemsForContact.mockResolvedValue([]);
  q.getCompletedActionItemsForContact.mockResolvedValue([]);
  q.getInteractions.mockResolvedValue([]);
  q.getAttachmentsForContact.mockResolvedValue([]);
});
afterEach(cleanup);

async function renderPage() {
  await act(async () => {
    render(<ContactDetailPage />);
  });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Timeline" })).toBeTruthy());
}

describe("timeline detail modal lifetime", () => {
  it("survives a background refresh with its own state intact", async () => {
    await renderPage();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "row" }));
    });
    const opened = await screen.findByText(/detail open/);
    const instance = opened.textContent;
    const mountsAtOpen = mounts.count;

    // A completed loadRelatedData, which is what bumps dataGeneration and
    // re-keys the boundary. Driven through the same event the CAR-205 test uses
    // because it needs no child component to be real.
    await act(async () => {
      emitUiEvent(UI_EVENTS.conversationLogged, undefined);
    });
    await waitFor(() => expect(q.getInteractions).toHaveBeenCalledTimes(2));

    // Still open, still the SAME instance. Inside the boundary this is a fresh
    // mount, and every piece of state the modal owns is gone with it.
    expect(screen.getByText(/detail open/).textContent).toBe(instance);
    expect(mounts.count).toBe(mountsAtOpen);
  });

  it("re-keys the TAB on that same refresh, so the guard above is not vacuous", async () => {
    // The companion assertion. If dataGeneration stopped bumping, or the
    // boundary stopped keying on it, the test above would pass for the wrong
    // reason and stop guarding anything.
    await renderPage();
    const before = q.getInteractions.mock.calls.length;

    await act(async () => {
      emitUiEvent(UI_EVENTS.conversationLogged, undefined);
    });

    await waitFor(() => expect(q.getInteractions.mock.calls.length).toBe(before + 1));
  });
});
