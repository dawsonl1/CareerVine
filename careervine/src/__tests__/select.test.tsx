// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";

afterEach(cleanup);

const OPTIONS = [
  { value: "mobile", label: "Mobile" },
  { value: "work", label: "Work" },
  { value: "home", label: "Home" },
];

const trigger = () => screen.getByRole("combobox");
const listbox = () => screen.queryByRole("listbox");
const option = (name: string) => screen.getByRole("option", { name });
const surface = () => screen.getByRole("dialog");

/** What `aria-activedescendant` currently points at, resolved to its label. */
const activeOption = () => {
  const id = trigger().getAttribute("aria-activedescendant");
  return id ? document.getElementById(id)?.textContent?.trim() ?? null : null;
};

const press = (key: string, opts: { shift?: boolean } = {}) =>
  fireEvent.keyDown(trigger(), { key, shiftKey: opts.shift ?? false });

/** Matches modal.test.tsx: the trap's own keydown handler is the seam under test. */
const tab = (opts: { shift?: boolean } = {}) =>
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Tab",
    shiftKey: opts.shift ?? false,
  });

function BareSelect({ onChange = vi.fn(), value = "" }: { onChange?: (v: string) => void; value?: string }) {
  return <Select value={value} onChange={onChange} options={OPTIONS} placeholder="Phone type" ariaLabel="Phone type" />;
}

/**
 * The Select sits BEFORE another control on purpose. An earlier version of this
 * file put it last, which made trigger-to-option adjacency look natural when it
 * was an artifact of the fixture — the real call site has ~40 controls after it.
 */
function SelectInModal({
  onClose = vi.fn(),
  onChange = vi.fn(),
  hasUnsavedChanges = false,
}: { onClose?: () => void; onChange?: (v: string) => void; hasUnsavedChanges?: boolean }) {
  return (
    <Modal isOpen onClose={onClose} title="Edit contact" hasUnsavedChanges={hasUnsavedChanges}>
      <button type="button">before</button>
      <Select value="" onChange={onChange} options={OPTIONS} placeholder="Phone type" ariaLabel="Phone type" />
      <button type="button">after</button>
    </Modal>
  );
}

/**
 * CAR-198. The list used to portal to `document.body`, which put it outside the
 * modal's focus trap and outside its `aria-modal` subtree: unreachable by keyboard
 * and invisible to a screen reader, while looking perfectly correct on screen.
 */
describe("Select inside a Modal", () => {
  it("renders the open list inside the dialog surface", () => {
    render(<SelectInModal />);
    fireEvent.click(trigger());

    // The bug report's repro asserted the inverse: dialog.contains(option) === false.
    expect(surface().contains(option("Work"))).toBe(true);
    expect(listbox()!.parentElement).toBe(surface());
  });

  it("portals to document.body when there is no Modal around it", () => {
    render(<BareSelect />);
    fireEvent.click(trigger());

    expect(listbox()!.parentElement).toBe(document.body);
  });

  /**
   * Options are deliberately NOT tabbable. They carry no tabindex and are not
   * buttons, so `tabbableWithin` skips them and the dialog's tab order stays
   * trigger → next control, rather than routing through a list that a portal can
   * only ever append to the end of the surface.
   */
  it("keeps the open list out of the dialog's tab cycle", () => {
    render(<SelectInModal />);
    fireEvent.click(trigger());

    screen.getByText("after").focus();
    tab();

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });

  it("leaves focus on the trigger for the whole interaction", () => {
    render(<SelectInModal />);
    fireEvent.click(trigger());
    expect(document.activeElement).toBe(trigger());

    press("ArrowDown");
    expect(document.activeElement).toBe(trigger());
    expect(surface().contains(document.activeElement)).toBe(true);
  });

  it("leaves the surrounding dialog open when an option is committed", () => {
    const onClose = vi.fn();
    const onChange = vi.fn();
    render(<SelectInModal onClose={onClose} onChange={onChange} />);
    fireEvent.click(trigger());

    fireEvent.click(option("Work"));

    expect(onChange).toHaveBeenCalledWith("work");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeTruthy();
  });
});

/**
 * Escape has to resolve one layer at a time. Before CAR-198 the list had no Escape
 * handling at all, so the key reached the Modal's document listener and closed the
 * whole dialog while the orphaned list stayed painted.
 */
describe("Select Escape layering", () => {
  it("closes only the list, leaving the dialog open", () => {
    const onClose = vi.fn();
    render(<SelectInModal onClose={onClose} />);
    fireEvent.click(trigger());

    press("Escape");

    expect(listbox()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeTruthy();
  });

  it("closes the dialog on Escape when no list is open", () => {
    const onClose = vi.fn();
    render(<SelectInModal onClose={onClose} />);

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes the dialog on the second Escape, once the list has gone", () => {
    const onClose = vi.fn();
    render(<SelectInModal onClose={onClose} />);
    fireEvent.click(trigger());

    press("Escape");
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /**
   * Regression pin for the review's most severe finding: a list left open under a
   * newly opened layer swallowed that layer's Escape and dragged focus back down
   * into the covered dialog, leaving Keep editing / Discard unreachable.
   *
   * What actually closes that hole is the blur-close asserted here — the confirm
   * dialog's own trap focuses "Keep editing", which blurs the trigger and takes the
   * list down with it, so the stale state cannot exist by the time Escape arrives.
   * `handleEscapeCapture`'s focus check is belt-and-braces behind that and has no
   * reachable path of its own to assert; removing it does not fail this test.
   */
  it("takes its list down when a layer opens above it, so Escape reaches that layer", () => {
    render(<SelectInModal hasUnsavedChanges />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(screen.getByText("Keep editing"));

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

/** The header claimed arrow / Enter / Escape support; there were zero handlers. */
describe("Select keyboard navigation", () => {
  it("opens onto the selected option with ArrowDown", () => {
    render(<BareSelect value="work" />);

    press("ArrowDown");

    expect(listbox()).toBeTruthy();
    expect(activeOption()).toBe("Work");
  });

  it("opens onto the last option with ArrowUp when nothing is selected", () => {
    render(<BareSelect />);

    press("ArrowUp");

    expect(activeOption()).toBe("Home");
  });

  it("moves down the list and wraps past the end", () => {
    render(<BareSelect />);
    press("ArrowDown");
    expect(activeOption()).toBe("Mobile");

    press("ArrowDown");
    expect(activeOption()).toBe("Work");
    press("ArrowDown");
    expect(activeOption()).toBe("Home");
    press("ArrowDown");
    expect(activeOption()).toBe("Mobile");
  });

  it("moves up the list and wraps past the start", () => {
    render(<BareSelect />);
    press("ArrowDown");

    press("ArrowUp");

    expect(activeOption()).toBe("Home");
  });

  it("jumps to the ends with Home and End", () => {
    render(<BareSelect />);
    press("ArrowDown");

    press("End");
    expect(activeOption()).toBe("Home");
    press("Home");
    expect(activeOption()).toBe("Mobile");
  });

  it("commits the active option on Enter and closes the list", () => {
    const onChange = vi.fn();
    render(<BareSelect onChange={onChange} />);
    press("ArrowDown");
    press("ArrowDown");

    press("Enter");

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("work");
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("commits on Space", () => {
    const onChange = vi.fn();
    render(<BareSelect onChange={onChange} />);
    press("ArrowUp");

    press(" ");

    expect(onChange).toHaveBeenCalledWith("home");
  });

  it("closes on Tab rather than stranding an open list behind the next field", () => {
    render(<BareSelect />);
    press("ArrowDown");
    expect(listbox()).toBeTruthy();

    press("Tab");

    expect(listbox()).toBeNull();
  });

  it("closes when focus leaves the trigger", () => {
    render(<BareSelect />);
    press("ArrowDown");
    expect(listbox()).toBeTruthy();

    fireEvent.blur(trigger());

    expect(listbox()).toBeNull();
  });

  it("does not open an empty list", () => {
    render(<Select value="" onChange={vi.fn()} options={[]} placeholder="Phone type" ariaLabel="Phone type" />);

    press("ArrowDown");
    expect(listbox()).toBeNull();
    press("Enter");
    expect(listbox()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("navigates an option whose value is the empty string", () => {
    // The real follow-up-frequency Select ships one; a value-keyed lookup used to
    // be the thing at risk here.
    const onChange = vi.fn();
    render(
      <Select
        value="7"
        onChange={onChange}
        options={[{ value: "", label: "No follow-up" }, { value: "7", label: "Weekly" }]}
        placeholder="Frequency"
        ariaLabel="Frequency"
      />,
    );
    press("ArrowDown");
    expect(activeOption()).toBe("Weekly");

    press("ArrowDown");
    expect(activeOption()).toBe("No follow-up");
    press("Enter");

    expect(onChange).toHaveBeenCalledWith("");
  });

  it("keeps navigating when two options share a value", () => {
    // Latent before: a value-keyed node map collapsed duplicates onto one node and
    // pinned focus. Index-based activedescendant cannot.
    render(
      <Select
        value=""
        onChange={vi.fn()}
        options={[{ value: "x", label: "First" }, { value: "x", label: "Second" }, { value: "z", label: "Third" }]}
        placeholder="Dupes"
        ariaLabel="Dupes"
      />,
    );
    press("ArrowDown");

    press("ArrowDown");
    expect(activeOption()).toBe("Second");
    press("ArrowDown");
    expect(activeOption()).toBe("Third");
  });
});

describe("Select combobox semantics", () => {
  it("reports its role, expanded state and the list it owns", () => {
    render(<BareSelect />);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().getAttribute("aria-haspopup")).toBe("listbox");
    expect(trigger().getAttribute("aria-controls")).toBeNull();

    fireEvent.click(trigger());

    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().getAttribute("aria-controls")).toBe(listbox()!.id);
  });

  it("carries a field name that survives choosing a value", () => {
    render(<BareSelect value="work" />);
    // Without aria-label the accessible name becomes "Work", so a screen reader
    // user cannot tell which field they are on.
    expect(screen.getByRole("combobox", { name: "Phone type" })).toBeTruthy();
  });

  it("marks the committed option as selected", () => {
    render(<BareSelect value="work" />);
    fireEvent.click(trigger());

    expect(option("Work").getAttribute("aria-selected")).toBe("true");
    expect(option("Home").getAttribute("aria-selected")).toBe("false");
  });

  it("closes on an outside mousedown", () => {
    render(<BareSelect />);
    fireEvent.click(trigger());
    expect(listbox()).toBeTruthy();

    fireEvent.mouseDown(document.body);

    expect(listbox()).toBeNull();
  });
});
