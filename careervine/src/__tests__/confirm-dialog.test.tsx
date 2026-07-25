// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { useConfirm } from "@/components/ui/confirm-dialog";

afterEach(cleanup);

/**
 * The promise contract is what these tests are really about (CAR-188). A
 * declarative dialog would be covered by asserting what renders; this one is
 * awaited by a suspended handler, so what matters is that every exit path
 * settles, and settles with the right answer.
 */

/** Harness that records what each `confirm()` resolved to, in order. */
function Harness({
  options = "Delete this?",
  onSettled,
}: {
  options?: Parameters<ReturnType<typeof useConfirm>["confirm"]>[0];
  onSettled: (confirmed: boolean) => void;
}) {
  const { confirm, confirmDialog } = useConfirm();
  return (
    <div>
      <button type="button" onClick={() => void confirm(options).then(onSettled)}>
        Ask
      </button>
      {confirmDialog}
    </div>
  );
}

const ask = () => fireEvent.click(screen.getByText("Ask"));
const dialog = () => screen.queryByTestId("confirm-dialog");

/** Let the microtask the promise resolves on actually run. */
const flush = () => act(async () => { await Promise.resolve(); });

describe("useConfirm", () => {
  it("renders nothing until asked", () => {
    render(<Harness onSettled={() => {}} />);
    expect(dialog()).toBeNull();
  });

  it("resolves true and closes when confirmed", async () => {
    const settled: boolean[] = [];
    render(<Harness onSettled={(c) => settled.push(c)} />);

    ask();
    expect(screen.getByText("Delete this?")).toBeTruthy();

    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    await flush();

    expect(settled).toEqual([true]);
    expect(dialog()).toBeNull();
  });

  it("resolves false when cancelled", async () => {
    const settled: boolean[] = [];
    render(<Harness onSettled={(c) => settled.push(c)} />);

    ask();
    fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));
    await flush();

    expect(settled).toEqual([false]);
    expect(dialog()).toBeNull();
  });

  it("resolves false on Escape", async () => {
    const settled: boolean[] = [];
    render(<Harness onSettled={(c) => settled.push(c)} />);

    ask();
    fireEvent.keyDown(document, { key: "Escape" });
    await flush();

    expect(settled).toEqual([false]);
    expect(dialog()).toBeNull();
  });

  it("resolves false on a scrim click", async () => {
    const settled: boolean[] = [];
    render(<Harness onSettled={(c) => settled.push(c)} />);

    ask();
    // The scrim is the absolutely-positioned sibling of the dialog surface.
    const scrim = dialog()!.parentElement!.querySelector(".absolute")!;
    fireEvent.click(scrim);
    await flush();

    expect(settled).toEqual([false]);
  });

  /**
   * The failure this guards is not a wrong answer but no answer: an awaiting
   * handler stays suspended forever, and several of the migrated ones hold a
   * `submittingRef` whose `finally` would then never run, wedging the control.
   */
  it("resolves false when the component unmounts with a question open", async () => {
    const settled: boolean[] = [];
    const view = render(<Harness onSettled={(c) => settled.push(c)} />);

    ask();
    expect(dialog()).toBeTruthy();

    view.unmount();
    await flush();

    expect(settled).toEqual([false]);
  });

  it("resolves a superseded question false rather than dropping it", async () => {
    const settled: boolean[] = [];
    render(<Harness onSettled={(c) => settled.push(c)} />);

    ask();
    ask();
    await flush();
    expect(settled).toEqual([false]);

    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    await flush();
    expect(settled).toEqual([false, true]);
  });

  /**
   * As written in CAR-188 this proved the wrong thing (CAR-204): fireEvent
   * flushes React synchronously, so by the time the Escape fired the dialog had
   * already unmounted and removed its own listener — it demonstrated listener
   * teardown, not the `pendingRef.current = null` guard inside `settle`. Both
   * events go in one un-flushed act() so the guard is what does the work.
   */
  it("settles exactly once even when two exits fire before React commits", async () => {
    const settled: boolean[] = [];
    render(<Harness onSettled={(c) => settled.push(c)} />);

    ask();
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
      fireEvent.keyDown(document, { key: "Escape" });
    });

    expect(settled).toEqual([true]);
  });

  it("moves focus back to Cancel when a new question supersedes an open one", async () => {
    // Without a key on ConfirmDialog a supersede reconciles in place, and none
    // of useFocusTrap's deps move when it does — so the trap never re-runs and
    // question 2 would open with focus wherever question 1 left it, possibly on
    // the destructive button (CAR-204).
    const settled: boolean[] = [];
    render(<Harness onSettled={(c) => settled.push(c)} />);

    ask();
    screen.getByTestId("confirm-dialog-confirm").focus();
    expect(document.activeElement).toBe(screen.getByTestId("confirm-dialog-confirm"));

    ask();
    await flush();

    expect(document.activeElement).toBe(screen.getByTestId("confirm-dialog-cancel"));
  });

  it("locks body scroll while open and restores it on close", async () => {
    render(<Harness onSettled={() => {}} />);
    expect(document.body.style.overflow).not.toBe("hidden");

    ask();
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));
    await flush();
    expect(document.body.style.overflow).not.toBe("hidden");
  });
});

describe("ConfirmDialog presentation", () => {
  it("defaults the copy and takes a bare string as the message", () => {
    render(<Harness onSettled={() => {}} />);
    ask();

    expect(screen.getByText("Are you sure?")).toBeTruthy();
    expect(screen.getByText("Delete this?")).toBeTruthy();
    expect(screen.getByTestId("confirm-dialog-confirm").textContent).toBe("Confirm");
    expect(screen.getByTestId("confirm-dialog-cancel").textContent).toBe("Cancel");
  });

  it("takes a full options object, including a non-literal message", () => {
    // The provider-key-card case: message comes from a per-provider config,
    // which is why `message` is a prop rather than hardcoded copy.
    const removeConfirm = "Remove your Deepgram key? Transcription will stop working.";
    render(
      <Harness
        options={{
          message: removeConfirm,
          title: "Remove key",
          confirmLabel: "Remove",
          cancelLabel: "Keep it",
          destructive: true,
        }}
        onSettled={() => {}}
      />,
    );
    ask();

    expect(screen.getByText(removeConfirm)).toBeTruthy();
    expect(screen.getByText("Remove key")).toBeTruthy();
    expect(screen.getByTestId("confirm-dialog-confirm").textContent).toBe("Remove");
    expect(screen.getByTestId("confirm-dialog-cancel").textContent).toBe("Keep it");
    expect(screen.getByTestId("confirm-dialog-confirm").className).toContain("bg-error");
  });

  it("is an alertdialog named and described by its own copy", () => {
    render(<Harness onSettled={() => {}} />);
    ask();

    const surface = screen.getByRole("alertdialog");
    expect(surface.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(surface.getAttribute("aria-labelledby")!)?.textContent)
      .toBe("Are you sure?");
    expect(document.getElementById(surface.getAttribute("aria-describedby")!)?.textContent)
      .toBe("Delete this?");
  });

  /**
   * APG: focus the least destructive action on an irreversible one. Cancel
   * leading in DOM order is what makes the shared trap's "focus the first
   * tabbable" land there, so this pins the ordering, not just the styling.
   */
  it("moves focus to Cancel on open", () => {
    render(<Harness onSettled={() => {}} />);
    ask();
    expect(document.activeElement).toBe(screen.getByTestId("confirm-dialog-cancel"));
  });

  it("wraps Tab at the edges", () => {
    render(<Harness onSettled={() => {}} />);
    ask();

    const cancel = screen.getByTestId("confirm-dialog-cancel");
    const confirmBtn = screen.getByTestId("confirm-dialog-confirm");

    // Forward off the last control wraps to the first.
    confirmBtn.focus();
    fireEvent.keyDown(confirmBtn, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);

    // Shift+Tab off the first wraps to the last.
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirmBtn);
  });
});
