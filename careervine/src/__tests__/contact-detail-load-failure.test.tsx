// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import { mockAuthProviderModule } from "./helpers/mock-auth-provider";
import { mockToastModule } from "./helpers/mock-toast";

/**
 * CAR-205, finding 6b. `loadRelatedData` caught into `console.error`, so on a
 * failed read every state it owns kept its previous value — `[]` on mount. The
 * Actions, Timeline and Attachments tabs then each rendered their load-empty
 * copy, claiming the contact has no open action items, no history and no files.
 *
 * The Emails tab is excluded from the fix and asserted here to stay excluded: it
 * reads from `loadContactEmails`, which owns its own failure flags, so hiding it
 * behind this one would report a failure it did not have.
 *
 * The tab components are doubled rather than rendered for real. What is under
 * test is which branch the PAGE takes, and rendering the real tabs would drag in
 * their own queries and assert their empty copy instead of the page's choice.
 */

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
  useQuickCapture: () => ({ open: vi.fn() }),
}));
vi.mock("@/hooks/use-capabilities", () => ({
  useCapabilities: () => ({ can: () => true }),
}));

// Tab and card doubles. Each renders the copy the real one shows when its data
// is empty, which is exactly the lie the fix has to stop reaching the screen.
vi.mock("@/components/contacts/contact-actions-tab", () => ({
  ContactActionsTab: () => <p>No open action items</p>,
}));
vi.mock("@/components/contacts/contact-timeline-tab", () => ({
  ContactTimelineTab: () => <p>No history yet</p>,
}));
vi.mock("@/components/contacts/contact-attachments-tab", () => ({
  ContactAttachmentsTab: () => <p>No files yet</p>,
}));
vi.mock("@/components/contacts/contact-emails-tab", () => ({
  ContactEmailsTab: () => <p>emails tab</p>,
}));
vi.mock("@/components/contacts/contact-profile-card", () => ({
  ContactProfileCard: () => <div />,
}));
vi.mock("@/components/contacts/contact-about-card", () => ({ ContactAboutCard: () => <div /> }));
vi.mock("@/components/contacts/contact-experience-card", () => ({
  ContactExperienceCard: () => <div />,
}));
vi.mock("@/components/contacts/contact-follow-up-status", () => ({
  ContactFollowUpStatus: () => <div />,
}));
vi.mock("@/components/contacts/contact-quick-actions", () => ({
  ContactQuickActions: () => <div />,
}));
vi.mock("@/components/contacts/contact-edit-modal", () => ({ ContactEditModal: () => null }));
vi.mock("@/components/contacts/contact-pending-actions-banner", () => ({
  ContactPendingActionsBanner: () => null,
}));

import ContactDetailPage from "@/app/contacts/[id]/page";

const FAILED = "Couldn't load this contact's activity.";

function relatedReadsResolve() {
  q.getMeetingsForContact.mockResolvedValue([]);
  q.getActionItemsForContact.mockResolvedValue([]);
  q.getCompletedActionItemsForContact.mockResolvedValue([]);
  q.getInteractions.mockResolvedValue([]);
  q.getAttachmentsForContact.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = "";
  q.getContactById.mockResolvedValue({
    id: 7,
    name: "Ada Lovelace",
    contact_emails: [],
    contact_companies: [],
  });
  q.getContacts.mockResolvedValue([]);
  q.getGmailConnection.mockResolvedValue(null);
  relatedReadsResolve();
});
afterEach(cleanup);

async function renderPage() {
  await act(async () => {
    render(<ContactDetailPage />);
  });
  // The tab bar, which the page renders itself. Anchoring on the contact's name
  // would not work: that lives in ContactProfileCard, which is doubled above.
  await waitFor(() => expect(screen.queryByRole("button", { name: "Timeline" })).toBeTruthy());
}

describe("contact detail related-data load failure", () => {
  it("renders the retryable error state on the Timeline tab, not its empty copy", async () => {
    q.getInteractions.mockRejectedValue(new Error("boom"));
    await renderPage();

    await waitFor(() => expect(screen.getByText(FAILED)).toBeTruthy());
    expect(screen.queryByText("No history yet")).toBeNull();
  });

  it("covers the Actions tab, whose empty copy is the costliest of the three", async () => {
    // "No open action items" for a contact who has them is the one that changes
    // what the user does next.
    q.getActionItemsForContact.mockRejectedValue(new Error("boom"));
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    });

    expect(screen.getByText(FAILED)).toBeTruthy();
    expect(screen.queryByText("No open action items")).toBeNull();
  });

  it("covers the Attachments tab", async () => {
    q.getAttachmentsForContact.mockRejectedValue(new Error("boom"));
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Attachments" }));
    });

    expect(screen.getByText(FAILED)).toBeTruthy();
    expect(screen.queryByText("No files yet")).toBeNull();
  });

  it("leaves the Emails tab alone, which owns its own failure flags", async () => {
    // Hiding it here would claim a failure the email read did not have.
    q.getInteractions.mockRejectedValue(new Error("boom"));
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Emails" }));
    });

    expect(screen.queryByText(FAILED)).toBeNull();
  });

  it("recovers on Retry", async () => {
    q.getInteractions.mockRejectedValueOnce(new Error("boom")).mockResolvedValue([]);
    await renderPage();
    await waitFor(() => expect(screen.getByText(FAILED)).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });

    await waitFor(() => expect(screen.queryByText(FAILED)).toBeNull());
    expect(screen.getByText("No history yet")).toBeTruthy();
  });

  it("shows the tabs normally when the reads succeed", async () => {
    // The companion: every assertion above is satisfied by a page that renders
    // the error state unconditionally.
    await renderPage();

    expect(screen.queryByText(FAILED)).toBeNull();
    expect(screen.getByText("No history yet")).toBeTruthy();
  });
});
