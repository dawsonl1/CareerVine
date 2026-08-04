// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

/**
 * CAR-216: the card used to render `contact.contact_companies` in the order the
 * join returned it, which is `company_id` ascending — when the app first met
 * each company, not this person's timeline. This asserts what the user actually
 * sees, in order, against a payload shaped like the production row that found
 * the bug (contact 114: four pre-existing companies floating above his lead
 * role, and a 2012 job rendering second).
 */

import { ContactExperienceCard } from "@/components/contacts/contact-experience-card";
import type { Contact } from "@/lib/types";

let nextId = 1;

function experience(
  companyName: string,
  title: string,
  start: string | null,
  end: string | null,
  isCurrent = false,
) {
  const id = nextId++;
  return {
    id,
    contact_id: 1,
    company_id: id,
    title,
    start_month: start,
    end_month: end,
    is_current: isCurrent,
    start_date: null,
    end_date: null,
    location: null,
    location_id: null,
    location_raw: null,
    location_source: null,
    employment_type: null,
    workplace_type: null,
    scraped_at: null,
    source: "scraped",
    companies: { id, name: companyName },
  };
}

function education(schoolName: string, start: number | null, end: number | null) {
  const id = nextId++;
  return {
    id,
    contact_id: 1,
    school_id: id,
    degree: null,
    field_of_study: null,
    start_year: start,
    end_year: end,
    schools: { id, name: schoolName },
  };
}

function contactWith(
  companies: ReturnType<typeof experience>[],
  schools: ReturnType<typeof education>[] = [],
) {
  return { contact_companies: companies, contact_schools: schools } as unknown as Contact;
}

afterEach(cleanup);

describe("ContactExperienceCard order", () => {
  it("renders current roles first, newest start first, regardless of join order", () => {
    // Deliberately in the company_id order PostgREST hands back.
    render(
      <ContactExperienceCard
        contact={contactWith([
          experience("Neighbor", "Board Member", "2017", "Present", true),
          experience("Qualtrics", "Marketing Org", "2012", "2014"),
          experience("Album VC", "General Partner", "Jul 2014", "Present", true),
          experience("Innovasis", "Operations", "Aug 2004", "Aug 2007"),
          experience("Elektrik", "Board Observer", "Mar 2021", "Present", true),
        ])}
      />,
    );

    const entries = screen.getAllByText(
      /Board Member|Marketing Org|General Partner|Operations|Board Observer/,
    );
    expect(entries.map((el) => el.textContent)).toEqual([
      "Board Observer", // Mar 2021, current
      "Board Member", // 2017, current
      "General Partner", // Jul 2014, current
      "Marketing Org", // 2012-2014
      "Operations", // 2004-2007
    ]);
  });

  it("orders past roles newest first even when month names sort the other way", () => {
    render(
      <ContactExperienceCard
        contact={contactWith([
          experience("Alpha", "Mar role", "Mar 2015", "Mar 2016"),
          experience("Beta", "Jul role", "Jul 2019", "Jul 2020"),
        ])}
      />,
    );

    const entries = screen.getAllByText(/Mar role|Jul role/);
    expect(entries.map((el) => el.textContent)).toEqual(["Jul role", "Mar role"]);
  });

  it("renders education newest first", () => {
    render(
      <ContactExperienceCard
        contact={contactWith(
          [],
          [education("State University", 2010, 2014), education("Grad School", 2016, 2018)],
        )}
      />,
    );

    const entries = screen.getAllByText(/State University|Grad School/);
    expect(entries.map((el) => el.textContent)).toEqual(["Grad School", "State University"]);
  });

  it("renders nothing when the contact has neither", () => {
    const { container } = render(<ContactExperienceCard contact={contactWith([], [])} />);
    expect(container.innerHTML).toBe("");
  });

  it("still renders undated rows, after the dated ones", () => {
    render(
      <ContactExperienceCard
        contact={contactWith([
          experience("Nowhere", "Undated role", null, null),
          experience("Somewhere", "Dated role", "Jan 2019", "Jan 2021"),
        ])}
      />,
    );

    const entries = screen.getAllByText(/Undated role|Dated role/);
    expect(entries.map((el) => el.textContent)).toEqual(["Dated role", "Undated role"]);
  });
});
