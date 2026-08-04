// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { mockToastModule } from "./helpers/mock-toast";
import type { Contact } from "@/lib/types";

/**
 * CAR-217. The contact page said nothing about a bounced address while the
 * compose modal and the companies person-modal both did, so the one surface a
 * user lands on to fix the address was the one that never mentioned it.
 *
 * The interesting part is not that an icon renders, it is WHICH address the
 * warning is about. The card picks the displayed address as "the primary row,
 * else row 0", and a warning derived from any-row-bounced instead would flag a
 * live address whenever a stale sibling existed on the same contact.
 */

const openCompose = vi.fn();

vi.mock("@/components/ui/toast", () => mockToastModule());
vi.mock("@/components/compose-email-context", () => ({
  useCompose: () => ({ gmailConnected: true, gmailLoading: false, openCompose }),
}));
vi.mock("@/lib/queries", () => ({
  updateContact: vi.fn(),
  addEmailToContact: vi.fn(),
  removeEmailsFromContact: vi.fn(),
  activateContact: vi.fn(),
  uploadContactPhoto: vi.fn(),
  removeContactPhoto: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(),
  jsonBody: vi.fn(() => ({})),
}));

import { ContactProfileCard } from "@/components/contacts/contact-profile-card";

type EmailRow = { id: number; email: string; is_primary: boolean; bounced_at: string | null };

function makeContact(emails: EmailRow[]): Contact {
  return {
    id: 7,
    name: "Dana Reed",
    network_status: "active",
    contact_status: null,
    contact_emails: emails,
    contact_phones: [],
    contact_companies: [],
    locations: null,
    linkedin_url: null,
    photo_url: null,
    industry: null,
    follow_up_frequency_days: null,
    last_scraped_at: null,
    scrape_failure_count: 0,
  } as unknown as Contact;
}

function renderCard(emails: EmailRow[]) {
  return render(
    <ContactProfileCard
      contact={makeContact(emails)}
      userId="user-1"
      onEdit={() => {}}
      onDelete={() => {}}
      onContactUpdate={() => {}}
    />,
  );
}

const WARNING = "The last email to this address bounced";

beforeEach(() => {
  openCompose.mockClear();
});
afterEach(cleanup);

describe("contact profile card bounce warning", () => {
  it("warns when the displayed address has bounced", () => {
    renderCard([{ id: 1, email: "dana@corp.com", is_primary: true, bounced_at: "2026-08-01T00:00:00Z" }]);
    expect(screen.getAllByLabelText(WARNING).length).toBeGreaterThan(0);
  });

  it("stays silent when the displayed address is live", () => {
    renderCard([{ id: 1, email: "dana@corp.com", is_primary: true, bounced_at: null }]);
    expect(screen.queryByLabelText(WARNING)).toBeNull();
  });

  it("does NOT warn when only a non-displayed sibling address bounced", () => {
    // The false positive an any-row check would produce: the primary address is
    // fine, an old secondary one is dead, and the card shows the primary.
    renderCard([
      { id: 1, email: "dana@corp.com", is_primary: true, bounced_at: null },
      { id: 2, email: "old@corp.com", is_primary: false, bounced_at: "2026-08-01T00:00:00Z" },
    ]);
    expect(screen.getByText("dana@corp.com")).toBeTruthy();
    expect(screen.queryByLabelText(WARNING)).toBeNull();
  });

  it("warns about the PRIMARY row even when a live sibling sorts first", () => {
    // Mirror image of the above: row 0 is live but is not the one displayed.
    renderCard([
      { id: 1, email: "live@corp.com", is_primary: false, bounced_at: null },
      { id: 2, email: "dana@corp.com", is_primary: true, bounced_at: "2026-08-01T00:00:00Z" },
    ]);
    expect(screen.getByText("dana@corp.com")).toBeTruthy();
    expect(screen.getAllByLabelText(WARNING).length).toBeGreaterThan(0);
  });

  it("hides the Send affordance for a bounced address", () => {
    // sendTrackedEmail refuses it with a 422, so offering Send could only ever
    // produce an error. Matches the companies person-modal.
    renderCard([{ id: 1, email: "dana@corp.com", is_primary: true, bounced_at: "2026-08-01T00:00:00Z" }]);
    expect(screen.queryByTitle("Send email")).toBeNull();
  });

  it("keeps the Send affordance for a live address", () => {
    renderCard([{ id: 1, email: "dana@corp.com", is_primary: true, bounced_at: null }]);
    expect(screen.getByTitle("Send email")).toBeTruthy();
  });

  it("shows no warning when the contact has no email at all", () => {
    renderCard([]);
    expect(screen.queryByLabelText(WARNING)).toBeNull();
  });
});
