// @vitest-environment jsdom
/**
 * The profile card's inline email edit stopped destroying the contact's other
 * addresses (CAR-279).
 *
 * It used to `removeEmailsFromContact` and re-add every address through a
 * writer that takes neither `source` nor `bounced_at`. One inline edit
 * therefore relabelled a scraped or pattern-guessed address as hand-entered and
 * cleared its bounce flag — resurrecting an address the daily bounce detector
 * had retired, against the documented promise that a permanent failure is
 * "refused everywhere after that".
 *
 * The provenance-preserving behaviour itself belongs to `replaceContactEmails`
 * and is asserted in contact-email-primary.test.ts. What this file pins is that
 * the card asks for the right END STATE: the displayed row edited, the others
 * left exactly as they were.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { mockToastModule } from "./helpers/mock-toast";
import type { Contact } from "@/lib/types";

type EmailEntry = { email: string; is_primary?: boolean };
let replacements: EmailEntry[][] = [];

vi.mock("@/components/ui/toast", () => mockToastModule());
vi.mock("@/components/compose-email-context", () => ({
  useCompose: () => ({ gmailConnected: false, openCompose: vi.fn() }),
}));
vi.mock("@/lib/queries", () => ({
  updateContact: vi.fn(async () => ({})),
  activateContact: vi.fn(async () => ({})),
  uploadContactPhoto: vi.fn(async () => ({})),
  removeContactPhoto: vi.fn(async () => ({})),
}));
vi.mock("@/lib/data/contacts", () => ({
  replaceContactEmails: (_id: number, entries: EmailEntry[]) => {
    replacements.push(entries.map((e) => ({ email: e.email, is_primary: e.is_primary })));
    return Promise.resolve({ inserted: 0, deleted: 0, primaryAddress: null });
  },
}));
vi.mock("@/lib/company-detail-cache", () => ({ invalidateCompanyScopes: vi.fn() }));
vi.mock("@/lib/companies-list-cache", () => ({ refreshCompaniesList: vi.fn() }));

const { ContactProfileCard } = await import("@/components/contacts/contact-profile-card");

type EmailFixture = { id: number; email: string; is_primary: boolean; source?: string; bounced_at?: string | null };

const contact = (emails: EmailFixture[]) =>
  ({
    id: 7,
    name: "Ada Lovelace",
    photo_url: null,
    linkedin_url: null,
    network_status: "active",
    notes: null,
    follow_up_frequency_days: null,
    contact_status: null,
    preferred_contact_method: null,
    preferred_contact_value: null,
    locations: null,
    scrape_failure_count: 0,
    contact_emails: emails.map((e) => ({ source: "manual", bounced_at: null, ...e })),
    contact_phones: [],
    contact_companies: [],
    contact_schools: [],
    contact_tags: [],
  }) as unknown as Contact;

const renderCard = (c: Contact) =>
  render(
    <ContactProfileCard
      contact={c}
      userId="u1"
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onContactUpdate={vi.fn()}
    />,
  );

/** Click the displayed address to open the inline editor, then type and blur. */
async function editDisplayedEmail(from: string, to: string) {
  fireEvent.click(screen.getByText(from));
  const input = await screen.findByDisplayValue(from);
  fireEvent.change(input, { target: { value: to } });
  fireEvent.blur(input);
}

beforeEach(() => {
  replacements = [];
});
afterEach(cleanup);

describe("Contact profile card — inline email edit (CAR-279)", () => {
  it("replaces the displayed address and leaves the others listed", async () => {
    renderCard(
      contact([
        { id: 1, email: "old@acme.com", is_primary: true, source: "verified" },
        { id: 2, email: "other@acme.com", is_primary: false, source: "scraped" },
      ]),
    );

    await editDisplayedEmail("old@acme.com", "new@acme.com");

    await waitFor(() => expect(replacements).toHaveLength(1));
    expect(replacements[0]).toEqual([
      { email: "new@acme.com", is_primary: true },
      { email: "other@acme.com", is_primary: undefined },
    ]);
  });

  it("does not re-send the untouched addresses with a primary flag of their own", async () => {
    // Two flagged entries would be a contact with two primaries — the exact
    // state the partial unique index now rejects outright.
    renderCard(
      contact([
        { id: 1, email: "old@acme.com", is_primary: true },
        { id: 2, email: "other@acme.com", is_primary: false },
      ]),
    );

    await editDisplayedEmail("old@acme.com", "new@acme.com");

    await waitFor(() => expect(replacements).toHaveLength(1));
    expect(replacements[0].filter((e) => e.is_primary)).toHaveLength(1);
  });

  it("clearing the field removes only that address, leaving the rest to inherit primary", async () => {
    renderCard(
      contact([
        { id: 1, email: "old@acme.com", is_primary: true },
        { id: 2, email: "other@acme.com", is_primary: false },
      ]),
    );

    await editDisplayedEmail("old@acme.com", "");

    await waitFor(() => expect(replacements).toHaveLength(1));
    expect(replacements[0]).toEqual([{ email: "other@acme.com", is_primary: undefined }]);
  });

  it("writes nothing when the address is left unchanged", async () => {
    renderCard(contact([{ id: 1, email: "old@acme.com", is_primary: true }]));

    await editDisplayedEmail("old@acme.com", "old@acme.com");

    expect(replacements).toEqual([]);
  });
});
