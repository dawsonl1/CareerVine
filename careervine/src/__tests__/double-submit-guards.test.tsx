// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import { mockToastModule, toastMock } from "./helpers/mock-toast";

// TodaySchedule reaches for the toast to report a create that failed after its
// popover was dismissed, which nothing else could surface (CAR-205 review).
vi.mock("@/components/ui/toast", () => mockToastModule());

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
    // The toast mock is module-level and would otherwise carry calls across
    // cases, which is how the "does not toast" companion below first passed on
    // the previous test's toast rather than on its own behaviour.
    vi.clearAllMocks();
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

  /**
   * Mount the schedule ONCE and return its drag surface.
   *
   * Kept separate from the drag below because `creatingRef` lives on this
   * component: a helper that re-rendered per draft gave each draft a fresh
   * instance and a fresh ref, so the cross-draft test it was written for
   * passed against the very bug it was meant to catch.
   */
  function renderSchedule() {
    const { container } = render(
      <TodaySchedule
        events={[]}
        loading={false}
        calendarConnected={true}
        availableHeight={800}
      />,
    );
    const grid = container.querySelector("[data-hour-grid]");
    if (!grid) throw new Error("hour grid not found");
    return grid;
  }

  /**
   * Drag out a draft on an already-mounted grid.
   *
   * jsdom reports a zeroed rect, which `yToHour` handles by clamping into the
   * hour range — fine here, because these tests count requests rather than
   * assert which hour was picked.
   */
  function dragOpenDraft(grid: Element, startY = 100, endY = 200) {
    fireEvent.mouseDown(grid, { clientY: startY });
    fireEvent.mouseMove(grid, { clientY: endY });
    fireEvent.mouseUp(grid, { clientY: endY });
    return screen.getByPlaceholderText("Add title");
  }

  function openDraftPopover() {
    return dragOpenDraft(renderSchedule());
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

  // A note on what is deliberately NOT tested here.
  //
  // `handleSaveNewEvent` carries its own draft-keyed guard at the POST site,
  // and deleting it outright leaves this file green. That is not a coverage
  // gap to paper over: the popover is its only caller, and the popover's own
  // ref already blocks every UI path, so a second entry is unreachable today.
  // The guard is defense in depth for a future second caller against a route
  // with no idempotency key.
  //
  // What IS pinned is the part that can go wrong: the test above proves the
  // guard is keyed on the DRAFT rather than on a boolean, which is the
  // distinction that made a latched flag swallow the user's second event. An
  // attempt to pin "the guard exists" by clicking Save twice in two `act()`
  // blocks passes with the guard deleted — React re-renders in between and the
  // second click lands on a disabled button — so it proved nothing and is gone.

  it("a second draft is not refused by the first draft's in-flight request", async () => {
    // The regression a bare boolean chokepoint guard caused. The popover
    // unmounts on dismissal while its request is still on the wire, so the ref
    // outlives the thing it guards; keyed on a boolean, the NEXT draft was
    // refused by the PREVIOUS draft's request, the child's promise resolved
    // without throwing, and the second popover sat at a disabled "Saving…"
    // with the user's event silently never created.
    // ONE mount, two drafts — the ref under test is shared across them.
    const grid = renderSchedule();
    const first = dragOpenDraft(grid, 100, 200);
    fireEvent.keyDown(first, { key: "Enter" });
    expect(posts).toHaveLength(1);

    // Dismiss mid-flight (Escape is not gated on `saving`), then draw another
    // over a different slot. The first request is still on the wire.
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    const second = dragOpenDraft(grid, 300, 400);
    await act(async () => {
      fireEvent.keyDown(second, { key: "Enter" });
    });

    // Two drafts are two events. Both must reach the wire. (The second popover
    // legitimately reads "Saving…" here — its request really is in flight; it
    // is the POST count that separates a working guard from a latched one.)
    expect(posts.filter((u) => u.includes("/api/calendar/create-event"))).toHaveLength(2);
  });

  /**
   * CAR-205. The three post-await commits in `handleSaveNewEvent` ran
   * unconditionally, so the response for a draft the user had already dismissed
   * reached in and operated on whatever draft was on screen instead.
   *
   * These need a fetch whose resolution is under the test's control, because the
   * whole defect lives in the window between draft A's response arriving and
   * draft B still being open. The `beforeEach` stub never resolves at all.
   */
  function controllableFetch() {
    const pending: Array<(r: Response) => void> = [];
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        urls.push(url);
        return new Promise<Response>((resolve) => pending.push(resolve));
      }),
    );
    const ok = () =>
      ({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: () => Promise.resolve({ success: true }),
        text: () => Promise.resolve('{"success":true}'),
      }) as unknown as Response;
    const err = () =>
      ({
        ok: false,
        status: 500,
        headers: { get: () => "application/json" },
        json: () => Promise.resolve({ error: "boom" }),
        text: () => Promise.resolve('{"error":"boom"}'),
      }) as unknown as Response;
    return {
      urls,
      /** Resolve the nth in-flight request, oldest first. */
      resolve: async (index: number) => {
        await act(async () => {
          pending[index]?.(ok());
        });
      },
      /** Fail the nth in-flight request with a 500. */
      fail: async (index: number) => {
        await act(async () => {
          pending[index]?.(err());
        });
      },
    };
  }

  it("a superseded response does not close the next draft's popover", async () => {
    // Draft A is saved and then dismissed while its POST is still on the wire —
    // the popover unmounts, the request does not. The user draws draft B and is
    // typing into it when A's response lands. An unconditional
    // `setNewEventDraft(null)` closed B under them.
    //
    // Note B is deliberately NOT saved here: `creatingRef.current` is therefore
    // still draft A, so a gate written as `creatingRef.current === newEventDraft`
    // passes and closes B anyway. Comparing against the LIVE draft is what makes
    // this case work.
    const net = controllableFetch();
    const grid = renderSchedule();

    const first = dragOpenDraft(grid, 100, 200);
    fireEvent.keyDown(first, { key: "Enter" });
    expect(net.urls).toHaveLength(1);

    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    dragOpenDraft(grid, 300, 400);
    expect(screen.queryByPlaceholderText("Add title")).toBeTruthy();

    await net.resolve(0);

    expect(screen.queryByPlaceholderText("Add title")).toBeTruthy();
  });

  it("toasts when a create fails after its popover was dismissed", async () => {
    // CAR-205 review. handleSaveNewEvent had no catch, so the rejection reached
    // only QuickAddCard's catch, which does setError on its own state. Dismiss
    // the popover mid-flight and that component is gone: React discards the
    // update silently and the user, who pressed Enter and closed the card,
    // believes the event exists. Nothing anywhere told them otherwise.
    const net = controllableFetch();
    const grid = renderSchedule();

    const input = dragOpenDraft(grid);
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(screen.queryByPlaceholderText("Add title")).toBeNull();

    await net.fail(0);

    expect(toastMock.error).toHaveBeenCalledWith("Couldn't create that event. Please try again.");
  });

  it("does not toast while the popover is still open, which shows its own error", async () => {
    // The companion. A toast here would double-report, and it would also mean
    // the gate was firing unconditionally rather than only when orphaned.
    const net = controllableFetch();
    const grid = renderSchedule();

    const input = dragOpenDraft(grid);
    fireEvent.keyDown(input, { key: "Enter" });
    await net.fail(0);

    await waitFor(() => expect(screen.getByText("Failed to create event")).toBeTruthy());
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  // The other half of CAR-205's fix — releasing `creatingRef` in the `finally`
  // only when it still holds THIS draft — is deliberately not tested here, for
  // the same reason the chokepoint guard itself is not (see the note above).
  //
  // A test for it was written and thrown away: draft A's response unlatches
  // draft B's claim, but a further Enter on B never reaches the chokepoint at
  // all, because QuickAddCard's own `savingRef` is still latched for B's
  // in-flight request and early-returns first. The test passed against the
  // unconditional `finally` it was written to catch. The correction is still
  // right — an unconditional release does hand back the claim — but as with the
  // guard it defends, no UI path can observe it while the popover is the only
  // caller, and a test that cannot fail is worse than none.

  /**
   * CAR-205 review. The quick-add popover is a DOM descendant of the drag
   * surface, and `handleGridMouseDown` closes any open draft on a mousedown it
   * does not recognise. It recognises `[data-popover]` — which nothing in the
   * repo rendered, so the exemption never matched and every mousedown inside the
   * card destroyed the draft before the click could land.
   *
   * These use fireEvent.mouseDown deliberately. Every pre-existing test here
   * drives the card by keyboard or by a bare `click` MouseEvent, and a bare
   * click carries no preceding mousedown — which is exactly why a feature that
   * was unusable with a real mouse had a green suite over it.
   */
  it("saves when Save is pressed with a real mouse, not just a synthetic click", () => {
    const grid = renderSchedule();
    dragOpenDraft(grid);
    const save = screen.getByRole("button", { name: "Save" });

    fireEvent.mouseDown(save);
    // The whole defect in one assertion: before the fix the card was already
    // unmounted here, so the click below landed on nothing.
    expect(screen.queryByRole("button", { name: "Save" })).toBeTruthy();
    fireEvent.mouseUp(save);
    fireEvent.click(save);

    expect(posts.filter((u) => u.includes("/api/calendar/create-event"))).toHaveLength(1);
  });

  it("keeps the draft and the typed title when the title input is clicked", () => {
    const grid = renderSchedule();
    const input = dragOpenDraft(grid);
    fireEvent.change(input, { target: { value: "Coffee with Ada" } });

    fireEvent.mouseDown(input);

    const after = screen.queryByPlaceholderText("Add title") as HTMLInputElement | null;
    expect(after).toBeTruthy();
    expect(after?.value).toBe("Coffee with Ada");
  });

  it("keeps the draft when the Add Google Meet control is clicked", () => {
    const grid = renderSchedule();
    dragOpenDraft(grid);

    fireEvent.mouseDown(screen.getByText(/Meet/i));

    expect(screen.queryByPlaceholderText("Add title")).toBeTruthy();
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
