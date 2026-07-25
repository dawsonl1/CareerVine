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

const trigger = () => screen.getByRole("button", { name: "Phone type" });
const option = (name: string) => screen.getByRole("button", { name });
const surface = () => screen.getByRole("dialog");

/** The portalled menu, reached the way a screen reader would: through aria-controls. */
const menu = () => document.getElementById(trigger().getAttribute("aria-controls")!);

const openMenu = () => fireEvent.click(trigger());

/** Matches modal.test.tsx: the trap's own keydown handler is the seam under test. */
const tab = (opts: { shift?: boolean } = {}) =>
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Tab",
    shiftKey: opts.shift ?? false,
  });

function BareSelect({ onChange = vi.fn(), value = "" }: { onChange?: (v: string) => void; value?: string }) {
  return <Select value={value} onChange={onChange} options={OPTIONS} placeholder="Phone type" />;
}

function SelectInModal({
  onClose = vi.fn(),
  onChange = vi.fn(),
}: { onClose?: () => void; onChange?: (v: string) => void }) {
  return (
    <Modal isOpen onClose={onClose} title="Edit contact">
      <button type="button">before</button>
      <Select value="" onChange={onChange} options={OPTIONS} placeholder="Phone type" />
    </Modal>
  );
}

/**
 * CAR-198. The menu used to portal to `document.body`, which put it outside the
 * modal's focus trap: `tabbableWithin(surface)` walks surface descendants only, so
 * the trap's set held zero options and Tab could never enter the open menu.
 */
describe("Select inside a Modal", () => {
  it("renders the open menu inside the dialog surface", () => {
    render(<SelectInModal />);
    openMenu();

    // The bug report's repro asserted the inverse: dialog.contains(option) === false.
    expect(surface().contains(option("Work"))).toBe(true);
    expect(menu()!.parentElement).toBe(surface());
  });

  it("puts the portalled options into the trap's tabbable set", () => {
    render(<SelectInModal />);
    openMenu();
    // Portals append, so the menu's last option is the dialog's last tabbable.
    screen.getByRole("button", { name: "Close" }).focus();

    tab({ shift: true });

    expect(document.activeElement).toBe(option("Home"));
  });

  it("wraps Tab from the last option back to the top of the dialog", () => {
    render(<SelectInModal />);
    openMenu();
    option("Home").focus();

    tab();

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });

  it("drops the options back out of the cycle once the menu closes", () => {
    render(<SelectInModal />);
    openMenu();
    fireEvent.keyDown(option("Work"), { key: "Escape" });

    screen.getByRole("button", { name: "Close" }).focus();
    tab({ shift: true });

    // The trigger is the last tabbable again, as it was before the menu opened.
    expect(document.activeElement).toBe(trigger());
  });

  it("portals to document.body when there is no Modal around it", () => {
    render(<BareSelect />);
    openMenu();

    expect(menu()!.parentElement).toBe(document.body);
  });

  /**
   * The keyboard handler is a React onKeyDown on the portalled menu, and React
   * routes events from a portal through the React tree rather than the DOM one.
   * Every other navigation test below portals to `document.body`, so without this
   * pair the surface-as-portal-target path would go unexercised — and it is the
   * only path the live call sites take.
   */
  it("still navigates and commits with the menu portalled to the surface", () => {
    const onChange = vi.fn();
    render(<SelectInModal onChange={onChange} />);
    openMenu();
    option("Mobile").focus();

    fireEvent.keyDown(option("Mobile"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(option("Work"));

    fireEvent.keyDown(option("Work"), { key: "Enter" });

    // Exactly once: React attaches a delegated listener to the portal container
    // as well as to the root, and a double dispatch would commit twice.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("work");
    expect(document.activeElement).toBe(trigger());
  });

  it("leaves the surrounding dialog open when an option is committed", () => {
    const onClose = vi.fn();
    render(<SelectInModal onClose={onClose} />);
    openMenu();

    fireEvent.click(option("Work"));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeTruthy();
  });
});

/**
 * Escape has to resolve one layer at a time. Before CAR-198 the menu had no
 * Escape handling at all, so the key reached the Modal's document listener and
 * closed the whole dialog while the orphaned menu stayed painted.
 */
describe("Select Escape layering", () => {
  it("closes only the menu, leaving the dialog open", () => {
    const onClose = vi.fn();
    render(<SelectInModal onClose={onClose} />);
    openMenu();

    fireEvent.keyDown(option("Work"), { key: "Escape" });

    expect(screen.queryByRole("button", { name: "Work" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeTruthy();
  });

  it("closes the dialog on Escape when no menu is open", () => {
    const onClose = vi.fn();
    render(<SelectInModal onClose={onClose} />);

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes the dialog on the second Escape, once the menu has gone", () => {
    const onClose = vi.fn();
    render(<SelectInModal onClose={onClose} />);
    openMenu();

    fireEvent.keyDown(option("Work"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("returns focus to the trigger, rather than dropping it outside the trap", () => {
    render(<SelectInModal />);
    openMenu();
    option("Work").focus();

    fireEvent.keyDown(option("Work"), { key: "Escape" });

    expect(document.activeElement).toBe(trigger());
  });
});

/** The header claimed arrow / Enter / Escape support; there were zero handlers. */
describe("Select keyboard navigation", () => {
  it("opens onto the first option with ArrowDown", () => {
    render(<BareSelect />);

    fireEvent.keyDown(trigger(), { key: "ArrowDown" });

    expect(document.activeElement).toBe(option("Mobile"));
  });

  it("opens onto the last option with ArrowUp", () => {
    render(<BareSelect />);

    fireEvent.keyDown(trigger(), { key: "ArrowUp" });

    expect(document.activeElement).toBe(option("Home"));
  });

  it("moves down the list and wraps past the end", () => {
    render(<BareSelect />);
    openMenu();
    option("Work").focus();

    fireEvent.keyDown(option("Work"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(option("Home"));

    fireEvent.keyDown(option("Home"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(option("Mobile"));
  });

  it("moves up the list and wraps past the start", () => {
    render(<BareSelect />);
    openMenu();
    option("Mobile").focus();

    fireEvent.keyDown(option("Mobile"), { key: "ArrowUp" });

    expect(document.activeElement).toBe(option("Home"));
  });

  it("jumps to the ends with Home and End", () => {
    render(<BareSelect />);
    openMenu();
    option("Work").focus();

    fireEvent.keyDown(option("Work"), { key: "End" });
    expect(document.activeElement).toBe(option("Home"));

    fireEvent.keyDown(option("Home"), { key: "Home" });
    expect(document.activeElement).toBe(option("Mobile"));
  });

  it("commits the focused option on Enter and closes the menu", () => {
    const onChange = vi.fn();
    render(<BareSelect onChange={onChange} />);
    openMenu();
    option("Work").focus();

    fireEvent.keyDown(option("Work"), { key: "Enter" });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("work");
    expect(screen.queryByRole("button", { name: "Work" })).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("commits on Space", () => {
    const onChange = vi.fn();
    render(<BareSelect onChange={onChange} />);
    openMenu();
    option("Home").focus();

    fireEvent.keyDown(option("Home"), { key: " " });

    expect(onChange).toHaveBeenCalledWith("home");
  });

  it("returns focus to the trigger after a click commit", () => {
    const onChange = vi.fn();
    render(<BareSelect onChange={onChange} />);
    openMenu();

    fireEvent.click(option("Work"));

    expect(onChange).toHaveBeenCalledWith("work");
    expect(document.activeElement).toBe(trigger());
  });
});

describe("Select trigger semantics", () => {
  it("reports its expanded state and owns the menu it opens", () => {
    render(<BareSelect />);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().getAttribute("aria-controls")).toBeNull();

    openMenu();

    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(menu()).toBeTruthy();
  });

  it("marks the selected option rather than leaving the check icon to carry it alone", () => {
    render(<BareSelect value="work" />);
    // With a value chosen, the trigger's own label is the selected option's.
    const selectedTrigger = screen.getByRole("button", { name: "Work" });
    fireEvent.click(selectedTrigger);

    const selected = screen
      .getAllByRole("button", { name: "Work" })
      .find((el) => el !== selectedTrigger)!;
    expect(selected.getAttribute("aria-current")).toBe("true");
    expect(option("Home").getAttribute("aria-current")).toBeNull();
  });
});
