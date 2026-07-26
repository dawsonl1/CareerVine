// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Modal } from "@/components/ui/modal";
import { DatePicker } from "@/components/ui/date-picker";
import { TimePicker } from "@/components/ui/time-picker";

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
