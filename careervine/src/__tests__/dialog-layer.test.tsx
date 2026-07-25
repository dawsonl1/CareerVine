// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});

const escape = () => fireEvent.keyDown(document.body, { key: "Escape" });

/** A Modal with a focusable child, so the trap has somewhere real to land. */
function Layer({
  title,
  isOpen = true,
  onClose = vi.fn(),
  hasUnsavedChanges = false,
}: {
  title: string;
  isOpen?: boolean;
  onClose?: () => void;
  hasUnsavedChanges?: boolean;
}) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} hasUnsavedChanges={hasUnsavedChanges}>
      <button type="button">{title} field</button>
    </Modal>
  );
}

/**
 * CAR-202. Every dialog in this app listens for Escape on document/window, and a
 * document-level listener fires for every layer regardless of which is on top, so one
 * keypress dismissed the whole stack. Measured before the fix:
 * `Escape with both open -> dialogs left: 0, closeA: 1, closeB: 1`.
 *
 * The scroll lock had the mirror-image bug: each dialog released its own, so the first
 * to unmount set `overflow: unset` under everything still open.
 */
describe("stacked Modals", () => {
  it("dismisses only the top layer on Escape", () => {
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    render(
      <>
        <Layer title="Outer" onClose={closeOuter} />
        <Layer title="Inner" onClose={closeInner} />
      </>,
    );

    escape();

    expect(closeInner).toHaveBeenCalledTimes(1);
    expect(closeOuter).not.toHaveBeenCalled();
  });

  it("hands Escape back to the layer below once the top one closes", () => {
    const closeOuter = vi.fn();
    const { rerender } = render(
      <>
        <Layer title="Outer" onClose={closeOuter} />
        <Layer title="Inner" />
      </>,
    );

    rerender(
      <>
        <Layer title="Outer" onClose={closeOuter} />
        <Layer title="Inner" isOpen={false} />
      </>,
    );
    escape();

    expect(closeOuter).toHaveBeenCalledTimes(1);
  });

  it("holds the scroll lock while any layer is open and releases it on the last", () => {
    const { rerender } = render(
      <>
        <Layer title="Outer" />
        <Layer title="Inner" />
      </>,
    );
    expect(document.body.style.overflow).toBe("hidden");

    // The inner one closing used to unlock the page under the outer one.
    rerender(
      <>
        <Layer title="Outer" />
        <Layer title="Inner" isOpen={false} />
      </>,
    );
    expect(document.body.style.overflow).toBe("hidden");

    rerender(
      <>
        <Layer title="Outer" isOpen={false} />
        <Layer title="Inner" isOpen={false} />
      </>,
    );
    expect(document.body.style.overflow).toBe("");
  });

  it("restores whatever overflow the page had, rather than assuming 'unset'", () => {
    document.body.style.overflow = "scroll";

    const { rerender } = render(<Layer title="Only" />);
    expect(document.body.style.overflow).toBe("hidden");

    rerender(<Layer title="Only" isOpen={false} />);

    expect(document.body.style.overflow).toBe("scroll");
  });
});

/**
 * The reachable instance, and the reason this shipped rather than staying a
 * two-Modal thought experiment: Edit Contact → Delete opens the *page's* useConfirm
 * dialog over the still-open modal. Escape there cancelled the delete and dismissed
 * the edit modal behind it in the same keypress, discarding the edits.
 */
describe("ConfirmDialog over a Modal", () => {
  const stack = (onModalClose: () => void, onCancel: () => void) => (
    <>
      <Layer title="Edit contact" onClose={onModalClose} />
      <ConfirmDialog message="Delete this contact?" onConfirm={vi.fn()} onCancel={onCancel} />
    </>
  );

  it("cancels only the confirm, leaving the modal open", () => {
    const onModalClose = vi.fn();
    const onCancel = vi.fn();
    render(stack(onModalClose, onCancel));

    escape();

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onModalClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeTruthy();
  });

  it("does not trip the modal's unsaved-changes guard either", () => {
    // Worse than closing: with hasUnsavedChanges the modal's Escape branch opened its
    // own confirm dialog *underneath* the one already up, stacking two alertdialogs.
    render(
      <>
        <Layer title="Edit contact" hasUnsavedChanges />
        <ConfirmDialog message="Delete this contact?" onConfirm={vi.fn()} onCancel={vi.fn()} />
      </>,
    );

    escape();

    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("keeps the scroll lock when the confirm closes over a still-open modal", () => {
    const { rerender } = render(stack(vi.fn(), vi.fn()));
    expect(document.body.style.overflow).toBe("hidden");

    rerender(<Layer title="Edit contact" />);

    expect(document.body.style.overflow).toBe("hidden");
  });
});

/**
 * ConfirmDiscardDialog is deliberately NOT a layer: it is rendered by Modal as that
 * modal's own confirmation step, and Modal's handler dismisses it through the
 * `showConfirm` branch. Registering it would make the Modal non-topmost and that
 * branch unreachable, so Escape would stop closing it at all.
 */
describe("Modal's own discard confirmation", () => {
  it("still answers Escape through the Modal's handler", () => {
    const onClose = vi.fn();
    render(<Layer title="Edit contact" onClose={onClose} hasUnsavedChanges />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    escape();

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeTruthy();
  });

  it("does not double-count the scroll lock when it opens and closes", () => {
    render(<Layer title="Edit contact" hasUnsavedChanges />);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    escape();

    expect(document.body.style.overflow).toBe("hidden");
  });
});
