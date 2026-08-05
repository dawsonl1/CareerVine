// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { mockAuthProviderModule } from "./helpers/mock-auth-provider";
import { mockToastModule } from "./helpers/mock-toast";

/**
 * CAR-229: /contacts/[id] fetched the user's ENTIRE contact list on mount — the
 * slowest request on a page about ONE contact, measured at 3.2s of its 4.9s
 * load. The only consumer is the ContactPicker inside the Actions tab's inline
 * edit form, so the fetch belongs to that tab, not to the page.
 *
 * Two things have to hold together, and the second is why this is not simply a
 * "don't call it" assertion: the tab also reads this contact's own name out of
 * that list to label its "Waiting on …" rows, so deferring the fetch without
 * seeding the current contact would make the label read "Waiting on them" until
 * the list arrived.
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
vi.mock("@/components/quick-capture-context", () => ({ useQuickCapture: () => ({ open: vi.fn() }) }));
vi.mock("@/hooks/use-capabilities", () => ({ useCapabilities: () => ({ can: () => true }) }));

// The Actions tab is doubled so the assertion is about the PAGE's choice of
// prop, not about how the real tab happens to render a picker.
vi.mock("@/components/contacts/contact-actions-tab", () => ({
  ContactActionsTab: ({ allContacts }: { allContacts: { id: number; name: string }[] }) => (
    <p>picker: {allContacts.map((c) => c.name).join(", ") || "(none)"}</p>
  ),
}));
vi.mock("@/components/contacts/contact-timeline-tab", () => ({
  ContactTimelineTab: () => <p>timeline tab</p>,
}));
vi.mock("@/components/contacts/contact-attachments-tab", () => ({ ContactAttachmentsTab: () => <p /> }));
vi.mock("@/components/contacts/contact-emails-tab", () => ({ ContactEmailsTab: () => <p /> }));
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

const contact = { id: 7, name: "Ada Lovelace", contact_emails: [] };

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = "";
  q.getContactById.mockResolvedValue(contact);
  q.getGmailConnection.mockResolvedValue(null);
  q.getMeetingsForContact.mockResolvedValue([]);
  q.getActionItemsForContact.mockResolvedValue([]);
  q.getCompletedActionItemsForContact.mockResolvedValue([]);
  q.getInteractions.mockResolvedValue([]);
  q.getAttachmentsForContact.mockResolvedValue([]);
  q.getContacts.mockResolvedValue([
    { id: 7, name: "Ada Lovelace" },
    { id: 8, name: "Grace Hopper" },
  ]);
});
afterEach(() => cleanup());

describe("ContactDetailPage — the full contact list is the Actions tab's cost", () => {
  it("does not fetch every contact to render the default tab", async () => {
    render(<ContactDetailPage />);
    await waitFor(() => expect(screen.getByText("timeline tab")).toBeTruthy());
    expect(q.getContacts).not.toHaveBeenCalled();
  });

  it("fetches it once when the Actions tab opens, and not again on re-entry", async () => {
    render(<ContactDetailPage />);
    await waitFor(() => expect(screen.getByText("timeline tab")).toBeTruthy());

    fireEvent.click(screen.getByText("Actions"));
    await waitFor(() => expect(screen.getByText("picker: Ada Lovelace, Grace Hopper")).toBeTruthy());
    expect(q.getContacts).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Timeline"));
    fireEvent.click(screen.getByText("Actions"));
    await waitFor(() => expect(screen.getByText("picker: Ada Lovelace, Grace Hopper")).toBeTruthy());
    expect(q.getContacts).toHaveBeenCalledTimes(1);
  });

  it("names this contact in the list before the fetch lands", async () => {
    // The tab resolves its "Waiting on <name>" label out of this prop, so an
    // empty list during the fetch would render "Waiting on them".
    let release!: (rows: unknown[]) => void;
    q.getContacts.mockReturnValue(new Promise((resolve) => { release = resolve; }));

    render(<ContactDetailPage />);
    await waitFor(() => expect(screen.getByText("timeline tab")).toBeTruthy());
    fireEvent.click(screen.getByText("Actions"));

    await waitFor(() => expect(screen.getByText("picker: Ada Lovelace")).toBeTruthy());

    // …and the seed does not survive as a duplicate once the real list lands.
    release([{ id: 7, name: "Ada Lovelace" }, { id: 8, name: "Grace Hopper" }]);
    await waitFor(() => expect(screen.getByText("picker: Ada Lovelace, Grace Hopper")).toBeTruthy());
  });

  it("still fetches on a direct load of #actions", async () => {
    window.location.hash = "#actions";
    render(<ContactDetailPage />);
    await waitFor(() => expect(q.getContacts).toHaveBeenCalledTimes(1));
  });
});
