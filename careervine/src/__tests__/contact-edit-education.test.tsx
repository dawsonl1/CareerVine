// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { mockToastModule } from "@/__tests__/helpers/mock-toast";
import type { Contact } from "@/lib/types";

vi.mock("@/components/ui/toast", () => mockToastModule());

/**
 * CAR-218: this modal held ONE set of education fields and its save path called
 * removeSchoolsFromContact on BOTH branches, so a contact with two degrees lost
 * one the first time anyone opened the modal and saved, even without touching
 * education. 43% of production contacts had more than one school. It also wrote
 * start_year/end_year as null, blanking the years sortEducation ranks on.
 *
 * These assert what reaches the data layer, because that is where the loss was:
 * the form looked entirely correct while doing it.
 */

type SchoolWrite = {
  contact_id: number;
  school_id: number;
  degree: string | null;
  field_of_study: string | null;
  start_year: number | null;
  end_year: number | null;
};

const schoolWrites: SchoolWrite[] = [];
const removals: number[] = [];
/** school name -> id, so a write can be traced back to the row that made it. */
const schoolIds = new Map<string, number>([
  ["Cambridge", 11],
  ["Royal Society", 22],
  ["Open University", 33],
]);

// The modal targets a hand-added contact's current employer on save (CAR-263).
// Unmocked, the real module reaches for a browser Supabase client and the save
// dies before the education writes this file is about.
vi.mock("@/lib/company-queries", () => ({
  ensureCompanyTargets: () => Promise.resolve(0),
}));

vi.mock("@/lib/queries", () => ({
  getTags: () => Promise.resolve([]),
  updateContact: () => Promise.resolve({}),
  findOrCreateSchool: (name: string) =>
    Promise.resolve({ id: schoolIds.get(name) ?? 99, name }),
  addSchoolToContact: (row: SchoolWrite) => {
    schoolWrites.push(row);
    return Promise.resolve({});
  },
  removeSchoolsFromContact: (id: number) => {
    removals.push(id);
    return Promise.resolve({});
  },
  findOrCreateCompany: () => Promise.resolve({ id: 1 }),
  addCompanyToContact: () => Promise.resolve({}),
  resolveManualCompanyLocation: () =>
    Promise.resolve({ location: null, location_id: null, location_source: null, location_raw: null }),
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

const school = (name: string, degree: string, start: number | null, end: number | null) => ({
  id: schoolIds.get(name)!,
  school_id: schoolIds.get(name)!,
  degree,
  field_of_study: "Mathematics",
  start_year: start,
  end_year: end,
  schools: { id: schoolIds.get(name)!, name },
});

const contact = (schools: ReturnType<typeof school>[]) =>
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
    contact_emails: [],
    contact_phones: [],
    contact_tags: [],
    contact_schools: schools,
  }) as unknown as Contact;

const renderModal = (schools: ReturnType<typeof school>[]) =>
  render(
    <ContactEditModal
      isOpen
      contact={contact(schools)}
      userId="u1"
      onClose={vi.fn()}
      onContactUpdate={vi.fn()}
      onContactDelete={vi.fn()}
    />,
  );

const save = () => fireEvent.click(screen.getByRole("button", { name: "Save" }));

beforeEach(() => {
  schoolWrites.length = 0;
  removals.length = 0;
});
afterEach(cleanup);

describe("Edit contact education", () => {
  const twoDegrees = [
    school("Cambridge", "B.S.", 1830, 1834),
    school("Royal Society", "Fellowship", 1840, 1843),
  ];

  it("keeps every degree when education is never touched", async () => {
    renderModal(twoDegrees);

    save();

    await waitFor(() => expect(schoolWrites.length).toBe(2));
    expect(schoolWrites.map((w) => w.school_id).sort()).toEqual([11, 22]);
  });

  it("writes each degree back with the years it came in with", async () => {
    renderModal(twoDegrees);

    save();

    await waitFor(() => expect(schoolWrites.length).toBe(2));
    const cambridge = schoolWrites.find((w) => w.school_id === 11);
    expect(cambridge).toMatchObject({ degree: "B.S.", start_year: 1830, end_year: 1834 });
    const royal = schoolWrites.find((w) => w.school_id === 22);
    expect(royal).toMatchObject({ degree: "Fellowship", start_year: 1840, end_year: 1843 });
  });

  it("lists degrees newest first, matching the profile card", () => {
    renderModal(twoDegrees);

    const degrees = screen.getAllByDisplayValue(/B\.S\.|Fellowship/);
    expect(degrees.map((el) => (el as HTMLInputElement).value)).toEqual(["Fellowship", "B.S."]);
  });

  it("saves a degree added through the form alongside the existing ones", async () => {
    renderModal(twoDegrees);

    fireEvent.click(screen.getByText("Add school"));
    const blank = screen.getAllByPlaceholderText(/Stanford University/i).at(-1)!;
    fireEvent.change(blank, { target: { value: "Open University" } });
    save();

    await waitFor(() => expect(schoolWrites.length).toBe(3));
    expect(schoolWrites.map((w) => w.school_id).sort()).toEqual([11, 22, 33]);
    expect(schoolWrites.find((w) => w.school_id === 33)).toMatchObject({
      start_year: null,
      end_year: null,
    });
  });

  it("removes only the degree whose remove button was clicked", async () => {
    renderModal(twoDegrees);

    // Rows render newest first, so row 1 is the Royal Society fellowship.
    fireEvent.click(screen.getByLabelText("Remove education 1"));
    save();

    await waitFor(() => expect(schoolWrites.length).toBe(1));
    expect(schoolWrites[0].school_id).toBe(11);
  });

  it("clears education only when every row is removed", async () => {
    renderModal(twoDegrees);

    fireEvent.click(screen.getByLabelText("Remove education 1"));
    fireEvent.click(screen.getByLabelText("Remove education 1"));
    save();

    await waitFor(() => expect(removals).toEqual([1]));
    expect(schoolWrites).toEqual([]);
  });

  it("still offers the disclosure for a contact with no education", () => {
    renderModal([]);

    expect(screen.queryByText("Add school")).toBeNull();
    fireEvent.click(screen.getByText("Add education"));
    expect(screen.getByText("Add school")).toBeTruthy();
    // Revealing the section seeds a row, so it is never opened empty.
    expect(screen.getAllByPlaceholderText(/Stanford University/i).length).toBe(1);
  });
});
