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
        <Modal isOpen onClose={closeOuter} title="Outer" />
        <Modal isOpen onClose={closeInner} title="Inner" />
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
        <Modal isOpen onClose={closeOuter} title="Outer" />
        <Modal isOpen onClose={vi.fn()} title="Inner" />
      </>,
    );

    rerender(
      <>
        <Modal isOpen onClose={closeOuter} title="Outer" />
        <Modal isOpen={false} onClose={vi.fn()} title="Inner" />
      </>,
    );
    escape();

    expect(closeOuter).toHaveBeenCalledTimes(1);
  });

  it("holds the scroll lock while any layer is open and releases it on the last", () => {
    const { rerender } = render(
      <>
        <Modal isOpen onClose={vi.fn()} title="Outer" />
        <Modal isOpen onClose={vi.fn()} title="Inner" />
      </>,
    );
    expect(document.body.style.overflow).toBe("hidden");

    // The inner one closing used to unlock the page under the outer one.
    rerender(
      <>
        <Modal isOpen onClose={vi.fn()} title="Outer" />
        <Modal isOpen={false} onClose={vi.fn()} title="Inner" />
      </>,
    );
    expect(document.body.style.overflow).toBe("hidden");

    rerender(
      <>
        <Modal isOpen={false} onClose={vi.fn()} title="Outer" />
        <Modal isOpen={false} onClose={vi.fn()} title="Inner" />
      </>,
    );
    expect(document.body.style.overflow).toBe("");
  });

  it("restores whatever overflow the page had, rather than assuming 'unset'", () => {
    document.body.style.overflow = "scroll";

    const { rerender } = render(<Modal isOpen onClose={vi.fn()} title="Only" />);
    expect(document.body.style.overflow).toBe("hidden");

    rerender(<Modal isOpen={false} onClose={vi.fn()} title="Only" />);

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
      <Modal isOpen onClose={onModalClose} title="Edit contact">
        <button type="button">Delete</button>
      </Modal>
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
        <Modal isOpen onClose={vi.fn()} title="Edit contact" hasUnsavedChanges>
          <button type="button">Delete</button>
        </Modal>
        <ConfirmDialog message="Delete this contact?" onConfirm={vi.fn()} onCancel={vi.fn()} />
      </>,
    );

    escape();

    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("keeps the scroll lock when the confirm closes over a still-open modal", () => {
    const { rerender } = render(stack(vi.fn(), vi.fn()));
    expect(document.body.style.overflow).toBe("hidden");

    rerender(<Modal isOpen onClose={vi.fn()} title="Edit contact" />);

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
    render(
      <Modal isOpen onClose={onClose} title="Edit contact" hasUnsavedChanges>
        <button type="button">field</button>
      </Modal>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    escape();

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeTruthy();
  });

  it("does not double-count the scroll lock when it opens and closes", () => {
    render(
      <Modal isOpen onClose={vi.fn()} title="Edit contact" hasUnsavedChanges>
        <button type="button">field</button>
      </Modal>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    escape();

    expect(document.body.style.overflow).toBe("hidden");
  });
});
