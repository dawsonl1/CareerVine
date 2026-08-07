// @vitest-environment jsdom
/**
 * `MultiSelect` (CAR-245).
 *
 * The popover mechanics it shares with `Select` are covered by `select.test.tsx`
 * against the same `useListboxPopover` hook, so this file stays on what differs:
 * toggling, the list staying open across picks, the "any" row, option-order
 * stability, and the trigger summary.
 *
 * Plain matchers throughout — the project does not load jest-dom.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Modal } from "@/components/ui/modal";
import { MultiSelect } from "@/components/ui/multi-select";

afterEach(cleanup);

const OPTIONS = [
  { value: "contacted", label: "Contacted" },
  { value: "replied", label: "Replied" },
  { value: "call_done", label: "Call done" },
];

const trigger = () => screen.getByRole("combobox");
const triggerText = () => trigger().textContent?.trim();
const listbox = () => screen.queryByRole("listbox");
const row = (name: string) => screen.getByRole("option", { name });
const rows = () => screen.getAllByRole("option");
const press = (key: string) => fireEvent.keyDown(trigger(), { key });

/** What `aria-activedescendant` points at, resolved to its label. */
const activeRow = () => {
  const id = trigger().getAttribute("aria-activedescendant");
  return id ? document.getElementById(id)?.textContent?.trim() ?? null : null;
};

/** Uncontrolled harness: toggles have to accumulate to be worth asserting. */
function Stateful({
  initial = [] as string[],
  onChange,
}: {
  initial?: string[];
  onChange?: (v: string[]) => void;
}) {
  const [values, setValues] = useState<string[]>(initial);
  return (
    <MultiSelect
      values={values}
      onChange={(v) => {
        setValues(v);
        onChange?.(v);
      }}
      options={OPTIONS}
      anyLabel="Any traction"
      ariaLabel="Filter by traction"
    />
  );
}

describe("MultiSelect selection", () => {
  it("toggles a value on and leaves the list open", () => {
    render(<Stateful />);
    fireEvent.click(trigger());
    fireEvent.click(row("Replied"));

    expect(listbox()).not.toBeNull();
    expect(triggerText()).toBe("Replied");
  });

  it("accumulates several values without reopening", () => {
    const onChange = vi.fn();
    render(<Stateful onChange={onChange} />);
    fireEvent.click(trigger());
    fireEvent.click(row("Replied"));
    fireEvent.click(row("Call done"));

    expect(onChange).toHaveBeenLastCalledWith(["replied", "call_done"]);
  });

  it("toggles a selected value back off", () => {
    const onChange = vi.fn();
    render(<Stateful initial={["replied"]} onChange={onChange} />);
    fireEvent.click(trigger());
    fireEvent.click(row("Replied"));

    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("emits values in option order, not click order", () => {
    // Otherwise the trigger label and the URL reshuffle as the user checks boxes.
    const onChange = vi.fn();
    render(<Stateful onChange={onChange} />);
    fireEvent.click(trigger());
    fireEvent.click(row("Call done"));
    fireEvent.click(row("Contacted"));

    expect(onChange).toHaveBeenLastCalledWith(["contacted", "call_done"]);
  });
});

describe("MultiSelect any row", () => {
  it("clears the whole selection", () => {
    const onChange = vi.fn();
    render(<Stateful initial={["replied", "call_done"]} onChange={onChange} />);
    fireEvent.click(trigger());
    fireEvent.click(row("Any traction"));

    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(triggerText()).toBe("Any traction");
  });

  it("reads as selected only while nothing is picked", () => {
    render(<Stateful />);
    fireEvent.click(trigger());
    expect(row("Any traction").getAttribute("aria-selected")).toBe("true");

    fireEvent.click(row("Replied"));
    expect(row("Any traction").getAttribute("aria-selected")).toBe("false");
    expect(row("Replied").getAttribute("aria-selected")).toBe("true");
  });

  it("leads the list, so it is the row an opening keypress lands on", () => {
    render(<Stateful />);
    fireEvent.click(trigger());

    expect(rows()[0].textContent?.trim()).toBe("Any traction");
    expect(activeRow()).toBe("Any traction");
  });
});

describe("MultiSelect trigger label", () => {
  it("shows the any label while nothing is selected", () => {
    render(<Stateful />);
    expect(triggerText()).toBe("Any traction");
  });

  it("shows the single selected label", () => {
    render(<Stateful initial={["call_done"]} />);
    expect(triggerText()).toBe("Call done");
  });

  it("summarizes several as the first label plus a count", () => {
    render(<Stateful initial={["replied", "call_done"]} />);
    expect(triggerText()).toBe("Replied +1");
  });

  it("shows a value that has no matching option rather than claiming Any", () => {
    // A `tier` from a shared URL may not exist in the loaded data. Reading
    // "Any tier" while that filter narrows the list is the one lie that matters.
    render(<Stateful initial={["Ghost Tier"]} />);
    expect(triggerText()).toBe("Ghost Tier");
  });
});

describe("MultiSelect keyboard", () => {
  it("toggles the active row on Enter and keeps the list open", () => {
    const onChange = vi.fn();
    render(<Stateful onChange={onChange} />);
    press("ArrowDown"); // opens on the "any" row
    press("ArrowDown"); // → Contacted
    press("ArrowDown"); // → Replied
    press("Enter");

    expect(onChange).toHaveBeenLastCalledWith(["replied"]);
    expect(listbox()).not.toBeNull();
  });

  it("toggles on Space", () => {
    const onChange = vi.fn();
    render(<Stateful onChange={onChange} />);
    press("ArrowDown");
    press("End");
    press(" ");

    expect(onChange).toHaveBeenLastCalledWith(["call_done"]);
  });

  it("clears from the keyboard through the any row", () => {
    const onChange = vi.fn();
    render(<Stateful initial={["replied"]} onChange={onChange} />);
    press("ArrowDown");
    press("Home");
    press("Enter");

    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("closes on Escape while keeping the selection", () => {
    render(<Stateful initial={["replied"]} />);
    fireEvent.click(trigger());
    fireEvent.keyDown(document, { key: "Escape" });

    expect(listbox()).toBeNull();
    expect(triggerText()).toBe("Replied");
  });

  it("opens onto the first selected row", () => {
    render(<Stateful initial={["call_done"]} />);
    press("ArrowDown");

    expect(activeRow()).toBe("Call done");
  });
});

describe("MultiSelect accessibility", () => {
  it("declares itself multi-selectable and names the field", () => {
    render(<Stateful initial={["replied"]} />);
    expect(trigger().getAttribute("aria-label")).toBe("Filter by traction");
    fireEvent.click(trigger());
    expect(listbox()?.getAttribute("aria-multiselectable")).toBe("true");
  });

  it("marks every selected row, not just one", () => {
    render(<Stateful initial={["contacted", "call_done"]} />);
    fireEvent.click(trigger());

    expect(rows().filter((r) => r.getAttribute("aria-selected") === "true")).toHaveLength(2);
  });

  it("renders the open list inside an enclosing dialog surface (CAR-198)", () => {
    // A list portalled to document.body sits outside the modal's focus trap and
    // outside its aria-modal subtree while looking perfectly correct on screen.
    render(
      <Modal isOpen onClose={vi.fn()} title="Filters">
        <Stateful />
      </Modal>,
    );
    fireEvent.click(trigger());

    expect(screen.getByRole("dialog").contains(row("Replied"))).toBe(true);
  });
});
