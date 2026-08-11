// @vitest-environment jsdom
/**
 * "Preferred" means primary (CAR-279).
 *
 * The checkbox wrote `contacts.preferred_contact_method/value` — two columns
 * nothing reads except this modal rehydrating its own checkbox — and never
 * touched `contact_emails.is_primary`, which is what every send path resolves.
 * Checking Preferred on a second address therefore changed nothing about where
 * mail went, and deleting the primary row left the contact with addresses and
 * no primary at all, which the AI follow-up generator reads as "no recipient".
 *
 * Assertions are on the address list handed to the data layer, because that is
 * the thing that decides; the form looked right the whole time it was wrong.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { mockToastModule } from "@/__tests__/helpers/mock-toast";
import type { Contact } from "@/lib/types";

vi.mock("@/components/ui/toast", () => mockToastModule());

type EmailWrite = { email: string; is_primary?: boolean };
let emailWrites: EmailWrite[][] = [];
let contactUpdates: Array<Record<string, unknown>> = [];

vi.mock("@/lib/company-queries", () => ({ ensureCompanyTargets: () => Promise.resolve(0) }));

vi.mock("@/lib/data/contacts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data/contacts")>();
  return {
    ...actual,
    replaceContactEmails: (_id: number, entries: EmailWrite[]) => {
      emailWrites.push(entries.map((e) => ({ email: e.email, is_primary: e.is_primary })));
      return Promise.resolve({ inserted: 0, deleted: 0, primaryAddress: null });
    },
  };
});

vi.mock("@/lib/queries", () => ({
  getTags: () => Promise.resolve([]),
  updateContact: (_id: number, payload: Record<string, unknown>) => {
    contactUpdates.push(payload);
    return Promise.resolve({});
  },
  findOrCreateSchool: () => Promise.resolve({ id: 1 }),
  addSchoolToContact: () => Promise.resolve({}),
  removeSchoolsFromContact: () => Promise.resolve({}),
  findOrCreateCompany: () => Promise.resolve({ id: 1 }),
  addCompanyToContact: () => Promise.resolve({}),
  resolveManualCompanyLocation: () =>
    Promise.resolve({ location: null, location_id: null, location_source: null, location_raw: null }),
  removeCompaniesFromContact: () => Promise.resolve({}),
  removePhonesFromContact: () => Promise.resolve({}),
  addPhoneToContact: () => Promise.resolve({}),
  createTag: () => Promise.resolve({ id: 1, name: "t" }),
  addTagToContact: () => Promise.resolve({}),
  removeTagFromContact: () => Promise.resolve({}),
  findOrCreateLocation: () => Promise.resolve({ id: 1 }),
}));

const { ContactEditModal } = await import("@/components/contacts/contact-edit-modal");

type EmailFixture = {
  id: number;
  email: string;
  is_primary: boolean;
  source?: string;
  bounced_at?: string | null;
};

const contact = (emails: EmailFixture[], over: Partial<Record<string, unknown>> = {}) =>
  ({
    id: 1,
    name: "Ada Lovelace",
    industry: "Software",
    linkedin_url: null,
    notes: null,
    met_through: null,
    follow_up_frequency_days: 30,
    contact_status: null,
    expected_graduation: null,
    preferred_contact_method: null,
    preferred_contact_value: null,
    locations: null,
    contact_companies: [],
    contact_emails: emails.map((e) => ({ source: "manual", bounced_at: null, ...e })),
    contact_phones: [],
    contact_tags: [],
    contact_schools: [],
    ...over,
  }) as unknown as Contact;

const renderModal = (c: Contact) =>
  render(
    <ContactEditModal
      isOpen
      contact={c}
      userId="u1"
      onClose={vi.fn()}
      onContactUpdate={vi.fn()}
      onContactDelete={vi.fn()}
    />,
  );

const save = () => fireEvent.click(screen.getByRole("button", { name: "Save" }));

/** The Preferred checkbox on the i-th email row. */
const preferredBox = (i: number) => {
  const row = screen.getByDisplayValue(emailAt(i)).closest("div")!;
  return within(row).getByRole("checkbox");
};
let addresses: string[] = [];
const emailAt = (i: number) => addresses[i];

const trashOn = (address: string) => {
  const row = screen.getByDisplayValue(address).closest("div")!;
  return within(row).getByRole("button");
};

beforeEach(() => {
  emailWrites = [];
  contactUpdates = [];
});
afterEach(cleanup);

describe("Edit contact — Preferred email is the primary email (CAR-279)", () => {
  const two: EmailFixture[] = [
    { id: 11, email: "work@acme.com", is_primary: true },
    { id: 22, email: "personal@gmail.com", is_primary: false },
  ];

  beforeEach(() => {
    addresses = two.map((e) => e.email);
  });

  it("marks the newly preferred address as primary", async () => {
    renderModal(contact(two));

    fireEvent.click(preferredBox(1));
    save();

    await waitFor(() => expect(emailWrites).toHaveLength(1));
    expect(emailWrites[0]).toEqual([
      { email: "work@acme.com", is_primary: false },
      { email: "personal@gmail.com", is_primary: true },
    ]);
  });

  it("records the preference on the contact as well, so both halves agree", async () => {
    renderModal(contact(two));

    fireEvent.click(preferredBox(1));
    save();

    await waitFor(() => expect(contactUpdates).toHaveLength(1));
    expect(contactUpdates[0]).toMatchObject({
      preferred_contact_method: "email",
      preferred_contact_value: "personal@gmail.com",
    });
  });

  it("leaves the primary where it is when nothing is touched", async () => {
    renderModal(contact(two));

    save();

    await waitFor(() => expect(emailWrites).toHaveLength(1));
    expect(emailWrites[0].find((e) => e.is_primary)?.email).toBe("work@acme.com");
  });

  it("hands primary to the survivor when the primary row is deleted", async () => {
    renderModal(contact(two));

    fireEvent.click(trashOn("work@acme.com"));
    save();

    await waitFor(() => expect(emailWrites).toHaveLength(1));
    expect(emailWrites[0]).toEqual([{ email: "personal@gmail.com", is_primary: true }]);
  });

  it("prefers a live survivor over one that has bounced", async () => {
    addresses = ["primary@acme.com", "dead@acme.com", "live@acme.com"];
    renderModal(
      contact([
        { id: 11, email: "primary@acme.com", is_primary: true },
        { id: 22, email: "dead@acme.com", is_primary: false, bounced_at: "2026-06-01T00:00:00Z" },
        { id: 33, email: "live@acme.com", is_primary: false },
      ]),
    );

    fireEvent.click(trashOn("primary@acme.com"));
    save();

    await waitFor(() => expect(emailWrites).toHaveLength(1));
    expect(emailWrites[0].find((e) => e.is_primary)?.email).toBe("live@acme.com");
  });

  it("shows which address is primary when the preferred method is a phone", () => {
    renderModal(
      contact(two, {
        preferred_contact_method: "phone",
        preferred_contact_value: "555-0100",
        contact_phones: [{ id: 5, phone: "555-0100", type: "mobile", is_primary: true }],
      }),
    );

    // Otherwise nothing on screen says where mail goes.
    const row = screen.getByDisplayValue("work@acme.com").closest("div")!;
    expect(within(row).getByText("Primary")).toBeTruthy();
  });

  it("does not label the row twice when Preferred is already checked on it", () => {
    renderModal(
      contact(two, { preferred_contact_method: "email", preferred_contact_value: "work@acme.com" }),
    );

    const row = screen.getByDisplayValue("work@acme.com").closest("div")!;
    expect(within(row).queryByText("Primary")).toBeNull();
    expect(within(row).getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
  });

  it("checks Preferred against the flag, not the stored string", () => {
    // The two are kept equal by a trigger; the flag is the one that decides.
    renderModal(
      contact(two, { preferred_contact_method: "email", preferred_contact_value: "stale@acme.com" }),
    );

    expect(preferredBox(0).getAttribute("aria-checked")).toBe("true");
    expect(preferredBox(1).getAttribute("aria-checked")).toBe("false");
  });
});
