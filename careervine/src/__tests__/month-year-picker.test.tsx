// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { MonthYearPicker, parseMonthYear } from "@/components/ui/month-year-picker";

afterEach(cleanup);

const trigger = () => screen.getByRole("button", { name: "Expected graduation" });
const monthButton = (label: string) => screen.getByRole("button", { name: label });
/**
 * The year the calendar is *showing*, scoped to the popup. A year-only value puts the
 * same string on the trigger, so an unscoped text query matches both.
 */
const viewYear = () => within(screen.getByRole("dialog")).getByText(/^\d{4}$/).textContent;

function Picker({ value = "", onChange = vi.fn() }: { value?: string; onChange?: (v: string) => void }) {
  return <MonthYearPicker value={value} onChange={onChange} ariaLabel="Expected graduation" placeholder="Select graduation month" />;
}

/**
 * CAR-200. `expected_graduation` is free-form text by schema and four writers put four
 * different shapes in it; the picker only understood its own. `parseInt("May 2027")`
 * is NaN, and neither `!== null` nor `??` catches NaN, so the field rendered
 * "undefined NaN" and picking a month wrote back the string "NaN-05".
 */
describe("parseMonthYear", () => {
  it("parses every shape that reaches the column", () => {
    expect(parseMonthYear("2026-05")).toEqual({ year: 2026, month: 4 });
    expect(parseMonthYear("2026-04-10")).toEqual({ year: 2026, month: 3 });
    expect(parseMonthYear("May 2027")).toEqual({ year: 2027, month: 4 });
    expect(parseMonthYear("Sep 2027")).toEqual({ year: 2027, month: 8 });
    expect(parseMonthYear("september 2027")).toEqual({ year: 2027, month: 8 });
    expect(parseMonthYear("2027")).toEqual({ year: 2027, month: null });
  });

  it("rejects an out-of-range month rather than indexing past the month names", () => {
    // Regex-well-formed but semantically junk. Without the range check these come
    // back as {month: 12} / {month: -1} and put `undefined` on screen by another door.
    expect(parseMonthYear("2026-13")).toBeNull();
    expect(parseMonthYear("2026-00")).toBeNull();
  });

  it("returns null for empty, whitespace and unrecognised text", () => {
    expect(parseMonthYear("")).toBeNull();
    expect(parseMonthYear("   ")).toBeNull();
    expect(parseMonthYear("sometime next spring")).toBeNull();
    expect(parseMonthYear("Maybe 2027")).toBeNull();
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseMonthYear("  May 2027 ")).toEqual({ year: 2027, month: 4 });
  });
});

describe("MonthYearPicker display", () => {
  it("renders the extension's own month-name output instead of 'undefined NaN'", () => {
    render(<Picker value="May 2027" />);

    expect(trigger().textContent).toContain("May 2027");
    expect(trigger().textContent).not.toContain("undefined");
    expect(trigger().textContent).not.toContain("NaN");
  });

  it("renders a year-only value as the year", () => {
    render(<Picker value="2027" />);
    expect(trigger().textContent).toContain("2027");
    expect(trigger().textContent).not.toContain("undefined");
  });

  it("canonicalises its own YYYY-MM output for display", () => {
    render(<Picker value="2026-05" />);
    expect(trigger().textContent).toContain("May 2026");
  });

  it("shows unparseable text as itself rather than as the placeholder", () => {
    // Showing the placeholder would tell the user the field is empty while it holds
    // data, which is how the value gets silently overwritten on the next save.
    render(<Picker value="sometime next spring" />);

    expect(trigger().textContent).toContain("sometime next spring");
    expect(trigger().textContent).not.toContain("Select graduation month");
  });

  it("shows the placeholder only when there is genuinely no value", () => {
    render(<Picker value="" />);
    expect(trigger().textContent).toContain("Select graduation month");
  });
});

describe("MonthYearPicker emission", () => {
  it("emits a well-formed YYYY-MM from a month-name value, never 'NaN-05'", () => {
    const onChange = vi.fn();
    render(<Picker value="May 2027" onChange={onChange} />);
    fireEvent.click(trigger());

    fireEvent.click(monthButton("May"));

    expect(onChange).toHaveBeenCalledWith("2027-05");
  });

  it("emits against the parsed year for a year-only value", () => {
    const onChange = vi.fn();
    render(<Picker value="2027" onChange={onChange} />);
    fireEvent.click(trigger());

    fireEvent.click(monthButton("Dec"));

    expect(onChange).toHaveBeenCalledWith("2027-12");
  });

  it("emits the current year when the stored value parses as nothing", () => {
    const onChange = vi.fn();
    render(<Picker value="sometime next spring" onChange={onChange} />);
    fireEvent.click(trigger());

    fireEvent.click(monthButton("Jan"));

    expect(onChange).toHaveBeenCalledWith(`${new Date().getFullYear()}-01`);
  });

  it("pads single-digit months", () => {
    const onChange = vi.fn();
    render(<Picker value="2026-11" onChange={onChange} />);
    fireEvent.click(trigger());

    fireEvent.click(monthButton("Mar"));

    expect(onChange).toHaveBeenCalledWith("2026-03");
  });
});

describe("MonthYearPicker calendar state", () => {
  it("opens on the parsed year, not the current one", () => {
    render(<Picker value="May 2027" />);
    fireEvent.click(trigger());

    expect(viewYear()).toBe("2027");
  });

  it("highlights the stored month for a month-name value", () => {
    render(<Picker value="May 2027" />);
    fireEvent.click(trigger());

    expect(monthButton("May").getAttribute("aria-pressed")).toBe("true");
    expect(monthButton("Jun").getAttribute("aria-pressed")).toBe("false");
  });

  it("highlights nothing for a year-only value: the year is known, the month is not", () => {
    render(<Picker value="2027" />);
    fireEvent.click(trigger());

    expect(viewYear()).toBe("2027");
    expect(monthButton("May").getAttribute("aria-pressed")).toBe("false");
  });

  it("re-seeds the view year when the value changes under a mounted picker", () => {
    // The old code seeded viewYear once with useState, so a value arriving later (a
    // different contact loaded into the same form) left the calendar on the wrong
    // year. NaN was masking it; fixing the parse would have uncovered it.
    const { rerender } = render(<Picker value="2027-05" />);
    fireEvent.click(trigger());
    expect(viewYear()).toBe("2027");
    fireEvent.click(trigger());

    rerender(<Picker value="2031-05" />);
    fireEvent.click(trigger());

    expect(viewYear()).toBe("2031");
  });

  it("keeps a manual year change while the calendar stays open", () => {
    const onChange = vi.fn();
    render(<Picker value="2026-05" onChange={onChange} />);
    fireEvent.click(trigger());

    fireEvent.click(screen.getByRole("button", { name: "Next year" }));
    fireEvent.click(monthButton("Jun"));

    expect(onChange).toHaveBeenCalledWith("2027-06");
  });
});

describe("MonthYearPicker clear", () => {
  it("clears the value, which is the only way out while contact_status stays student", () => {
    const onChange = vi.fn();
    render(<Picker value="May 2027" onChange={onChange} />);
    fireEvent.click(trigger());

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(onChange).toHaveBeenCalledWith("");
  });

  it("offers nothing to clear when the field is empty", () => {
    render(<Picker value="" />);
    fireEvent.click(trigger());

    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("can clear a value it cannot parse", () => {
    const onChange = vi.fn();
    render(<Picker value="sometime next spring" onChange={onChange} />);
    fireEvent.click(trigger());

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(onChange).toHaveBeenCalledWith("");
  });
});

describe("MonthYearPicker semantics", () => {
  it("carries a field name that survives choosing a date", () => {
    // Without it the accessible name is the trigger's text, i.e. the value itself —
    // the CAR-201 defect, on a different component.
    render(<Picker value="May 2027" />);
    expect(screen.getByRole("button", { name: "Expected graduation" })).toBeTruthy();
  });

  it("reports its expanded state", () => {
    render(<Picker value="" />);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger());

    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });
});
