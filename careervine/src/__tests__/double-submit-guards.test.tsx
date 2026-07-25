// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import { TodaySchedule } from "@/components/home/today-schedule";
import { UnifiedActionList, type UnifiedActionItem } from "@/components/home/unified-action-list";

/**
 * CAR-190: the two mutation handlers whose only re-entry guard was a boolean
 * state flag.
 *
 * CONVENTIONS.md section f has always said a double submit needs a synchronous
 * `useRef`, not a `disabled={saving}` state flag, and these are the two sites
 * that had the flag and nothing else. The state update does not land until the
 * next render, so both clicks of a fast double click get through, and no
 * disabled attribute gates a keyboard path at all.
 *
 * The schedule one is the expensive one: /api/calendar/create-event takes no
 * idempotency key, so every extra call creates a real Google Calendar event, a
 * real cache row, and (with the Meet toggle) a real Meet link the user has to
 * delete by hand.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * Two clicks in ONE tick, which is what a fast double click actually is.
 *
 * `fireEvent.click` twice in a row does not reproduce it: fireEvent wraps each
 * dispatch in act(), so React re-renders in between and the second click lands
 * on an already-disabled button. That makes `disabled={saving}` look sufficient
 * under test while it is not in a browser, and it is why both of these tests
 * passed against the unguarded code on the first attempt. Dispatching both
 * events inside a single act() batches the state update the way the browser
 * does, so the second handler runs with the first still in flight.
 */
function doubleClick(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("NewEventPopover double submit (today-schedule)", () => {
  let posts: string[];

  beforeEach(() => {
    posts = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        posts.push(url);
        // Never resolves within the test: the guard has to hold while the
        // request is still in flight, which is exactly the window that matters.
        return new Promise<Response>(() => {});
      }),
    );
  });

  /** Drag on the hour grid to open the new-event popover. */
  function openDraftPopover() {
    const { container } = render(
      <TodaySchedule
        events={[]}
        loading={false}
        calendarConnected={true}
        availableHeight={800}
      />,
    );

    // The grid is the drag surface; jsdom reports a zeroed rect, which yToHour
    // handles (it clamps into the hour range) and which is fine here because
    // the test cares about call count, not about which hour was picked.
    const grid = container.querySelector("[data-hour-grid]") ?? container.querySelector(".relative");
    if (!grid) throw new Error("hour grid not found");

    fireEvent.mouseDown(grid, { clientY: 100 });
    fireEvent.mouseMove(grid, { clientY: 200 });
    fireEvent.mouseUp(grid, { clientY: 200 });

    return screen.getByPlaceholderText("Add title");
  }

  it("fires one create-event POST for three Enter keydowns", () => {
    const input = openDraftPopover();

    // Key repeat delivers a burst of these; the disabled Save button gates
    // none of them, because this path never consults it.
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(posts.filter((u) => u.includes("/api/calendar/create-event"))).toHaveLength(1);
  });

  it("fires one create-event POST for a double-clicked Save", () => {
    openDraftPopover();
    doubleClick(screen.getByRole("button", { name: "Save" }));

    expect(posts.filter((u) => u.includes("/api/calendar/create-event"))).toHaveLength(1);
  });

  it("re-arms after a failed create so the retry actually retries", async () => {
    // Both guards latch on entry; if neither released, the popover's own
    // "Failed to create event" retry would be a silent no-op. apiSend throws on
    // a non-2xx, which the popover catches to show that message.
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        calls.push(url);
        return Promise.resolve({
          ok: false,
          status: 500,
          headers: { get: () => "application/json" },
          json: () => Promise.resolve({ error: "boom" }),
          text: () => Promise.resolve('{"error":"boom"}'),
        } as unknown as Response);
      }),
    );

    const input = openDraftPopover();
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await waitFor(() => expect(screen.getByText("Failed to create event")).toBeTruthy());
    expect(calls).toHaveLength(1);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    await waitFor(() => expect(calls).toHaveLength(2));
  });
});

describe("NotePopover double submit (unified-action-list)", () => {
  const item: UnifiedActionItem = {
    id: "ra-1",
    type: "recently_added",
    contactId: 7,
    contactName: "Ada Lovelace",
    contactPhotoUrl: null,
    primaryText: "Recently added",
    secondaryText: "",
    lastContactedLabel: "Never contacted",
    priority: 10,
  };

  function renderWithNote(onNote: (contactId: number, note: string) => Promise<void>) {
    render(
      <UnifiedActionList
        items={[item]}
        loading={false}
        onComplete={vi.fn()}
        onSnooze={vi.fn()}
        onDismiss={vi.fn()}
        onSave={vi.fn()}
        onLogInteraction={vi.fn()}
        onDraftEmail={vi.fn()}
        onNote={onNote}
        onIntro={vi.fn()}
        onOpenOnboarding={vi.fn()}
        isEmpty={false}
        onLogConversation={vi.fn()}
        calendarConnected={true}
        dismissedGettingStarted={[]}
        onDismissGettingStarted={vi.fn()}
      />,
    );
  }

  /**
   * ActionButton renders an icon-only <button> with its label in a sibling
   * span, so the button has no accessible name to query by. (Worth naming, but
   * that is the a11y tickets' surface, not this one.) Reach it through the
   * label instead.
   */
  function openNotePopover() {
    const label = screen.getByText("Note");
    const button = label.parentElement?.querySelector("button");
    if (!button) throw new Error("Note button not found");
    fireEvent.click(button);
  }

  it("saves one note for a double-clicked Save", async () => {
    const onNote = vi.fn(() => new Promise<void>(() => {})); // stays in flight
    renderWithNote(onNote);

    openNotePopover();
    fireEvent.change(screen.getByPlaceholderText("Add a quick note..."), {
      target: { value: "Met at the conference" },
    });

    doubleClick(screen.getByRole("button", { name: "Save" }));

    expect(onNote).toHaveBeenCalledTimes(1);
  });

  it("still saves once the note is entered, so the guard is not just blocking everything", () => {
    // The companion to the test above: a guard that never released would pass
    // "one call for two clicks" by making zero calls.
    const onNote = vi.fn(() => new Promise<void>(() => {}));
    renderWithNote(onNote);

    openNotePopover();
    fireEvent.change(screen.getByPlaceholderText("Add a quick note..."), {
      target: { value: "Met at the conference" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onNote).toHaveBeenCalledWith(7, "Met at the conference");
  });
});
