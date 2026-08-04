// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Modal } from "@/components/ui/modal";
import { DatePicker } from "@/components/ui/date-picker";
import { TimePicker } from "@/components/ui/time-picker";
import { ContactPicker } from "@/components/ui/contact-picker";
import { MonthYearPicker } from "@/components/ui/month-year-picker";

/**
 * CAR-205: Escape closes the open picker, not the dialog around it.
 *
 * `usePortalDropdown` had no keydown handling at all, which stayed invisible
 * until CAR-197 gave six dialogs Escape for the first time. `modal.tsx` listens
 * on `document`, so one press closed the dialog under the user and left the
 * picker behind.
 *
 * The pickers are asserted through the Modal rather than on their own, because
 * the defect is an interaction between two document-level listeners and the
 * order they run in. A picker rendered bare would pass with no handler at all.
 *
 * jsdom dispatches capture-phase listeners in spec order, so
 * `stopPropagation()` from the hook's capture listener really does prevent the
 * modal's bubble listener here, the same way it does in a browser.
 */

afterEach(cleanup);

const escape = () => fireEvent.keyDown(document, { key: "Escape" });
const dialogOpen = () => screen.queryAllByRole("dialog").length > 0;

function renderDatePickerInModal(onClose = vi.fn()) {
  render(
    <Modal isOpen onClose={onClose} title="Schedule">
      <DatePicker value="" onChange={vi.fn()} />
    </Modal>,
  );
  return onClose;
}

/** Open the calendar and return the trigger, which focus must come back to. */
function openCalendar() {
  const trigger = screen.getByText("Select date").closest("button");
  if (!trigger) throw new Error("date picker trigger not found");
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
}

describe("picker Escape inside a dialog", () => {
  it("closes only the picker, leaving the dialog open", () => {
    const onClose = renderDatePickerInModal();
    openCalendar();
    // The day grid is the calendar; "Today" is its shortcut row.
    expect(screen.queryByText("Today")).toBeTruthy();

    escape();

    expect(screen.queryByText("Today")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(dialogOpen()).toBe(true);
  });

  it("still lets a second Escape close the dialog once the picker is shut", () => {
    // The companion assertion: a handler that swallowed Escape unconditionally
    // would pass the test above by making the dialog un-dismissable.
    const onClose = renderDatePickerInModal();
    openCalendar();

    escape();
    escape();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("leaves the dialog's Escape alone when no picker is open", () => {
    const onClose = renderDatePickerInModal();

    escape();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("claims Escape while focus sits on a control inside the calendar", () => {
    // The reason this is not select.tsx's `activeElement === trigger` check.
    // These dropdowns are full of real buttons, and focus lands on one as soon
    // as the user clicks a month chevron — where the trigger-only test would
    // decline the key and hand the dialog its own dismissal.
    const onClose = renderDatePickerInModal();
    const trigger = openCalendar();

    const dayCell = screen.getByText("15").closest("button");
    if (!dayCell) throw new Error("day cell not found");
    dayCell.focus();
    // Proves the setup, not the fix: if this silently left focus on the trigger
    // the test would be asserting select.tsx's check, which already passes.
    expect(document.activeElement).toBe(dayCell);
    expect(document.activeElement).not.toBe(trigger);

    escape();

    expect(screen.queryByText("Today")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("returns focus to the trigger, so the dialog's trap stays armed", () => {
    // The trap is a keydown handler ON the surface; focus left on <body> walks
    // Tab straight out of the dialog.
    const onClose = renderDatePickerInModal();
    const trigger = openCalendar();
    // Focus a day cell first, so the assertion below is about the picker
    // handing focus back and not about focus never having left the trigger.
    screen.getByText("15").closest("button")?.focus();

    escape();

    expect(document.activeElement).toBe(trigger);
    // Paired with the dialog still being open, because the modal's own trap
    // ALSO restores focus to the trigger on the way out — without this the
    // assertion above passes just as well when Escape closed the whole dialog.
    expect(onClose).not.toHaveBeenCalled();
    expect(dialogOpen()).toBe(true);
  });

  /**
   * CAR-205 review. The hook fix covered the four PORTALLED pickers and stopped
   * there, but portalling is not what makes Escape ambiguous — having an open
   * list inside a dialog is. These four keep their list as a plain DOM child, so
   * they get the cheaper wrapper handler (`useDropdownEscape`) instead of a
   * document capture listener.
   *
   * The load-bearing claim being pinned here is that React's synthetic
   * `stopPropagation` reaches the native event at React's ROOT CONTAINER, which
   * sits below `document`, so `modal.tsx`'s document-level Escape never runs.
   * That is a real DOM-semantics question and is asserted rather than assumed.
   */
  it("closes only the suggestion list for a non-portalled dropdown in a dialog", () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose} title="Log a conversation">
        <ContactPicker
          allContacts={[
            { id: 1, name: "Ada Lovelace" },
            { id: 2, name: "Grace Hopper" },
          ]}
          selectedIds={[]}
          onChange={vi.fn()}
        />
      </Modal>,
    );

    const input = screen.getByPlaceholderText(/search/i);
    fireEvent.focus(input);
    expect(screen.queryByText("Ada Lovelace")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByText("Ada Lovelace")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(dialogOpen()).toBe(true);
  });

  it("still lets Escape close the dialog once that list is shut", () => {
    // The companion. A wrapper handler that swallowed Escape unconditionally
    // would pass the case above by making the dialog undismissable from inside
    // the picker, which is the failure mode the `open` gate exists to prevent.
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose} title="Log a conversation">
        <ContactPicker
          allContacts={[{ id: 1, name: "Ada Lovelace" }]}
          selectedIds={[]}
          onChange={vi.fn()}
        />
      </Modal>,
    );
    const input = screen.getByPlaceholderText(/search/i);
    fireEvent.focus(input);

    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /**
   * CAR-224. `useDropdownEscape` moves no focus, which is fine for a caller whose
   * trigger survives the close but not for one whose PANEL holds focusable controls:
   * Escape from one of those unmounts the focused element and strands focus on
   * `<body>`, which disarms the enclosing dialog's trap (a keydown handler on the
   * surface). Both non-portalled callers with such panels now hand focus back.
   */
  it("hands focus back to the trigger when a non-portalled panel closes (CAR-224)", () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose} title="Edit experience">
        <MonthYearPicker value="" onChange={vi.fn()} ariaLabel="Graduation" />
      </Modal>,
    );
    const trigger = screen.getByText("Select month").closest("button");
    if (!trigger) throw new Error("month picker trigger not found");
    trigger.focus();
    fireEvent.click(trigger);

    // Focus a real control inside the panel — that is what makes stranding
    // possible, since closing unmounts it.
    const nextYear = screen.getByLabelText("Next year");
    nextYear.focus();
    expect(document.activeElement).toBe(nextYear);

    fireEvent.keyDown(nextYear, { key: "Escape" });

    expect(screen.queryByLabelText("Next year")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("returns focus to the search input without reopening the list (CAR-224)", () => {
    // ContactPicker opens its list on input focus, so handing focus back would
    // undo the close it just did. The suppression must cover that one transition
    // and no more, or a later genuine focus silently stops opening the list.
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose} title="Log a conversation">
        <ContactPicker
          allContacts={[{ id: 1, name: "Ada Lovelace" }]}
          selectedIds={[]}
          onChange={vi.fn()}
        />
      </Modal>,
    );
    const input = screen.getByPlaceholderText(/search/i);
    fireEvent.focus(input);
    const suggestion = screen.getByText("Ada Lovelace").closest("button");
    if (!suggestion) throw new Error("suggestion not found");
    suggestion.focus();

    fireEvent.keyDown(suggestion, { key: "Escape" });

    expect(document.activeElement).toBe(input);
    expect(screen.queryByText("Ada Lovelace")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    // The flag did not leak: focusing the input again still opens the list.
    fireEvent.focus(input);
    expect(screen.queryByText("Ada Lovelace")).toBeTruthy();
  });

  it("applies to the time picker too, since the fix is in the shared hook", () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose} title="Schedule">
        <TimePicker value="" onChange={vi.fn()} />
      </Modal>,
    );
    const trigger = screen.getByText("Select time").closest("button");
    if (!trigger) throw new Error("time picker trigger not found");
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.queryByText("Hour")).toBeTruthy();

    escape();

    expect(screen.queryByText("Hour")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});
