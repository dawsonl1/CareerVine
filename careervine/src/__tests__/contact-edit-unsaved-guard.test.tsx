// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { mockToastModule } from "@/__tests__/helpers/mock-toast";
import type { Contact } from "@/lib/types";

vi.mock("@/components/ui/toast", () => mockToastModule());

/** Lets one test hold a save open to inspect the window while it is in flight. */
const saveGate: { block: boolean } = { block: false };

vi.mock("@/lib/queries", () => ({
  getTags: () => Promise.resolve([]),
  updateContact: () => (saveGate.block ? new Promise(() => {}) : Promise.resolve({})),
  findOrCreateSchool: () => Promise.resolve({ id: 1 }),
  addSchoolToContact: () => Promise.resolve({}),
  removeSchoolsFromContact: () => Promise.resolve({}),
  findOrCreateCompany: () => Promise.resolve({ id: 1 }),
  addCompanyToContact: () => Promise.resolve({}),
  resolveManualCompanyLocation: () => Promise.resolve({ location: null, location_id: null, location_source: null, location_raw: null }),
  removeCompaniesFromContact: () => Promise.resolve({}),
  removeEmailsFromContact: () => Promise.resolve({}),
  addEmailToContact: () => Promise.resolve({}),
  removePhonesFromContact: () => Promise.resolve({}),
  addPhoneToContact: () => Promise.resolve({}),
  createTag: () => Promise.resolve({ id: 1, name: "t" }),
  addTagToContact: () => Promise.resolve({}),
  removeTagFromContact: () => Promise.resolve({}),
  findOrCreateLocation: () => Promise.resolve({ id: 1 }),
}));

const { ContactEditModal } = await import("@/components/contacts/contact-edit-modal");

afterEach(cleanup);

/**
 * The unit test beside this one covers `serializeForm` in isolation, which cannot
 * see the failure that actually matters: the guard lives in the AGREEMENT between
 * the populate effect and that function. A field added to one and not the other
 * makes a freshly opened, untouched form read as dirty, so every dismissal warns
 * and users learn to click through the confirmation. These render the real thing.
 */
const contact = (over: Partial<Contact> = {}) =>
  ({
    id: 1,
    name: "Ada Lovelace",
    industry: "Software",
    linkedin_url: null,
    notes: "Met at RustConf",
    met_through: null,
    follow_up_frequency_days: 30,
    contact_status: null,
    expected_graduation: null,
    preferred_contact_method: null,
    preferred_contact_value: null,
    locations: { city: "Provo", state: "UT", country: "United States" },
    contact_companies: [],
    contact_emails: [{ email: "ada@example.com", is_primary: true }],
    contact_phones: [{ phone: "555-0100", type: "mobile", is_primary: true }],
    contact_tags: [{ tag_id: 3 }, { tag_id: 1 }],
    contact_schools: [],
    ...over,
  }) as unknown as Contact;

const renderModal = (props: Partial<Parameters<typeof ContactEditModal>[0]> = {}) => {
  const onClose = vi.fn();
  const utils = render(
    <ContactEditModal
      isOpen
      contact={contact()}
      userId="u1"
      onClose={onClose}
      onContactUpdate={vi.fn()}
      onContactDelete={vi.fn()}
      {...props}
    />,
  );
  return { onClose, ...utils };
};

const escape = () => fireEvent.keyDown(document.body, { key: "Escape" });
const notes = () => screen.getByPlaceholderText(/anything worth remembering/i);

describe("Edit contact unsaved-changes guard", () => {
  it("does not warn on a freshly opened, untouched form", () => {
    const { onClose } = renderModal();

    escape();

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("warns once a field has actually been edited", () => {
    const { onClose } = renderModal();
    fireEvent.change(notes(), { target: { value: "Met at RustConf, follow up" } });

    escape();

    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("routes the footer Cancel through the same guard as Escape", () => {
    const { onClose } = renderModal();
    fireEvent.change(notes(), { target: { value: "edited" } });

    fireEvent.click(screen.getByText("Cancel"));

    // Cancel used to call onClose directly, making it the one dismissal path of
    // four that discarded silently.
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("discards only when the user confirms", () => {
    const { onClose } = renderModal();
    fireEvent.change(notes(), { target: { value: "edited" } });
    escape();

    fireEvent.click(screen.getByText("Keep editing"));
    expect(onClose).not.toHaveBeenCalled();

    escape();
    fireEvent.click(screen.getByText("Discard"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not offer to discard edits that a delete would resolve anyway", () => {
    // handleDelete no longer closes first: the parent confirms and navigates, so a
    // declined confirm must leave the form intact rather than shut with edits gone.
    const onClose = vi.fn();
    const onContactDelete = vi.fn();
    render(
      <ContactEditModal
        isOpen
        contact={contact()}
        userId="u1"
        onClose={onClose}
        onContactUpdate={vi.fn()}
        onContactDelete={onContactDelete}
      />,
    );
    fireEvent.change(notes(), { target: { value: "edited" } });

    fireEvent.click(screen.getByText(/delete contact/i));

    expect(onContactDelete).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeTruthy();
  });

  it("does not offer to discard changes that are already being saved", async () => {
    // handleSave is a long serial chain of writes. Warning mid-flight tells the user
    // their edits "will be lost" when they are being persisted, and Discard cannot
    // stop them: the save completes and toasts success behind the closed modal.
    saveGate.block = true;
    try {
      const { onClose } = renderModal();
      fireEvent.change(notes(), { target: { value: "edited" } });
      fireEvent.click(screen.getByText(/^save$/i));
      await Promise.resolve();

      escape();

      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      saveGate.block = false;
    }
  });

  it("re-baselines on reopen rather than carrying the discarded session forward", () => {
    const { onClose, rerender } = renderModal();
    fireEvent.change(notes(), { target: { value: "abandoned draft" } });
    escape();
    fireEvent.click(screen.getByText("Discard"));
    expect(onClose).toHaveBeenCalledTimes(1);

    const props = {
      contact: contact(),
      userId: "u1",
      onClose,
      onContactUpdate: vi.fn(),
      onContactDelete: vi.fn(),
    };
    rerender(<ContactEditModal isOpen={false} {...props} />);
    rerender(<ContactEditModal isOpen {...props} />);

    escape();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
