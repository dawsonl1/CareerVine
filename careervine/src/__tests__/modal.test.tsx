// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Modal, useModalDismiss } from "@/components/ui/modal";

afterEach(cleanup);

/** The dialog surface, which is what owns the trap and the ARIA. */
const surface = () => screen.getByRole("dialog");

/**
 * Tab is driven with fireEvent rather than user-event, which is not a dependency
 * of this repo and which CAR-185 declined to add. That is not a shortcut: the
 * keydown handler *is* the seam the trap owns. jsdom implements no sequential
 * focus navigation at all, so the non-wrapping Tab case is deliberately not
 * asserted anywhere below. It is the browser's job, and simulating it here would
 * only assert the simulation. CAR-189's Playwright tier is where that lands.
 */
const tab = (opts: { shift?: boolean } = {}) =>
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Tab",
    shiftKey: opts.shift ?? false,
  });

/**
 * The Modal owns its body padding (CAR-48) — callers must NOT re-add
 * px-6/pb-6, or content double-indents. These tests lock the contract.
 */
describe("Modal body padding", () => {
  it("pads the body horizontally and below; headline supplies top spacing", () => {
    render(
      <Modal isOpen onClose={vi.fn()} title="With title">
        <p>body</p>
      </Modal>,
    );
    const body = screen.getByText("body").parentElement!;
    expect(body.className).toContain("px-6");
    expect(body.className).toContain("pb-6");
    expect(body.className).not.toContain("pt-6");
  });

  it("adds top padding when there is no title row", () => {
    render(
      <Modal isOpen onClose={vi.fn()}>
        <p>body</p>
      </Modal>,
    );
    const body = screen.getByText("body").parentElement!;
    expect(body.className).toContain("px-6");
    expect(body.className).toContain("pb-6");
    expect(body.className).toContain("pt-6");
  });

  it("renders nothing when closed", () => {
    render(
      <Modal isOpen={false} onClose={vi.fn()} title="Hidden">
        <p>body</p>
      </Modal>,
    );
    expect(screen.queryByText("body")).toBeNull();
  });
});

/**
 * Focus trap (CAR-185). Without one, Tab from the last control lands behind the
 * scrim and the user types into a form they cannot see.
 */
describe("Modal focus trap", () => {
  function Harness({ open }: { open: boolean }) {
    return (
      <>
        <button type="button">trigger</button>
        <Modal isOpen={open} onClose={vi.fn()} title="Edit contact">
          <button type="button">first</button>
          <button type="button">second</button>
        </Modal>
      </>
    );
  }

  it("moves focus into the dialog on open", () => {
    render(<Harness open />);
    // The headline's close button leads the tab order, so it takes initial focus.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    expect(surface().contains(document.activeElement)).toBe(true);
  });

  it("focuses the dialog container when there is nothing focusable inside", () => {
    render(
      <Modal isOpen onClose={vi.fn()}>
        <p>read only</p>
      </Modal>,
    );
    expect(document.activeElement).toBe(surface());
  });

  it("wraps Tab from the last focusable back to the first", () => {
    render(<Harness open />);
    screen.getByText("second").focus();

    tab();

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });

  it("wraps Shift+Tab from the first focusable round to the last", () => {
    render(<Harness open />);
    screen.getByRole("button", { name: "Close" }).focus();

    tab({ shift: true });

    expect(document.activeElement).toBe(screen.getByText("second"));
  });

  it("wraps Shift+Tab off the dialog container itself", () => {
    render(<Harness open />);
    surface().focus();

    tab({ shift: true });

    expect(document.activeElement).toBe(screen.getByText("second"));
  });

  it("leaves disabled controls out of the cycle", () => {
    render(
      <Modal isOpen onClose={vi.fn()} title="Edit contact">
        <button type="button">first</button>
        <button type="button" disabled>
          disabled
        </button>
      </Modal>,
    );
    // "first" is the last *tabbable*, so Tab must wrap rather than reach the
    // disabled button. jsdom reports tabIndex 0 for a disabled button, so a trap
    // filtering on the property instead of the attribute would fail right here.
    screen.getByText("first").focus();

    tab();

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });

  it("returns focus to the trigger when the modal closes", () => {
    const { rerender } = render(<Harness open={false} />);
    const trigger = screen.getByText("trigger");
    trigger.focus();

    rerender(<Harness open />);
    expect(document.activeElement).not.toBe(trigger);

    rerender(<Harness open={false} />);
    expect(document.activeElement).toBe(trigger);
  });
});

/**
 * CAR-198: children that must escape the surface's `overflow: hidden` — a Select
 * menu, any popover — portal INTO the surface so they stay inside the trap, and
 * rely on `position: fixed` not being clipped by an ancestor's overflow. That
 * holds only while neither the surface nor the wrapper around it forms a
 * containing block for fixed descendants.
 *
 * This is a source tripwire rather than a behavioral test on purpose: jsdom has no
 * layout engine, so the clipping it guards against cannot be observed here at all.
 * Verified in a real browser when the fix landed; this keeps a later entrance
 * animation from undoing it silently, since the failure is invisible to every
 * other test in this file.
 */
describe("Modal surface as a portal container", () => {
  const CONTAINING_BLOCK_UTILITIES = [
    /^-?(transform|rotate|scale|skew|translate)(-|$)/,
    /^(filter|blur|brightness|contrast|grayscale|invert|saturate|sepia|drop-shadow|hue-rotate)(-|$)/,
    /^backdrop-/,
    /^(perspective|contain|will-change|animate)(-|$)/,
    // Tailwind v4's container-query utility compiles to `container-type: inline-size`,
    // which applies layout containment. Spelled `@container`, so none of the above
    // catch it.
    /^@container(\/|-|$)/,
    // Arbitrary-property syntax, e.g. `[will-change:transform]`. Kept as a whole-token
    // pattern because the variant strip below cannot run on these.
    /^\[(transform|filter|backdrop-filter|perspective|contain|will-change|container-type|content-visibility):/,
  ];

  /**
   * These match a pattern above but compile to a value that establishes nothing:
   * `contain` only contains for layout/paint/strict/content, and `will-change` only
   * for transform/perspective/filter. Without this the guard fails on a class added
   * to *reset* an inherited style, with a message asserting the opposite of the truth.
   */
  const INERT_VALUES = /-(none|auto|scroll|contents|normal|size|style)$/;

  /**
   * A class with any variant prefix (`hover:`, `md:`, `motion-safe:`) stripped, by
   * splitting on the last colon at bracket depth zero.
   *
   * Brackets carry colons in both directions, so neither naive rule works: splitting
   * on every colon turns `[will-change:transform]` into `transform]`, and slicing from
   * the first `[` turns `data-[state=open]:animate-in` into `[state=open]:animate-in`.
   * Both then match nothing.
   */
  const withoutVariants = (token: string) => {
    let depth = 0;
    let start = 0;
    for (let i = 0; i < token.length; i++) {
      if (token[i] === "[") depth++;
      else if (token[i] === "]") depth--;
      else if (token[i] === ":" && depth === 0) start = i + 1;
    }
    return token.slice(start);
  };

  const utilities = (el: HTMLElement) =>
    el.className.split(/\s+/).filter(Boolean).map(withoutVariants);

  const assertNoContainingBlock = (el: HTMLElement, label: string) => {
    // Guard against a vacuous pass: Vitest does not fail a test that ran no
    // assertions, so classes moving to a CSS module or a `cn()` that resolved
    // empty would turn this green while checking nothing.
    expect(utilities(el).length, `${label} has no classes to check`).toBeGreaterThan(0);

    for (const utility of utilities(el)) {
      if (INERT_VALUES.test(utility)) continue;
      for (const pattern of CONTAINING_BLOCK_UTILITIES) {
        expect(
          pattern.test(utility),
          `"${utility}" on the ${label} makes it a containing block for fixed descendants, which clips every menu portalled into the dialog`,
        ).toBe(false);
      }
    }

    // The other idiomatic way to write an entrance animation, and invisible to a
    // className scan.
    const style = el.getAttribute("style") ?? "";
    for (const property of ["transform", "filter", "backdrop-filter", "perspective", "contain", "will-change", "container-type"]) {
      expect(
        new RegExp(`(^|[;\\s])${property}\\s*:`).test(style),
        `inline ${property} on the ${label} makes it a containing block for fixed descendants`,
      ).toBe(false);
    }
  };

  it("neither the surface nor its wrapper establishes one", () => {
    render(
      <Modal isOpen onClose={vi.fn()} title="Edit contact">
        <p>body</p>
      </Modal>,
    );

    assertNoContainingBlock(surface(), "dialog surface");
    assertNoContainingBlock(surface().parentElement as HTMLElement, "dialog wrapper");
  });

  it("keeps the surface clipping its own overflow, which is why children portal out of it", () => {
    render(
      <Modal isOpen onClose={vi.fn()} title="Edit contact">
        <p>body</p>
      </Modal>,
    );
    expect(surface().className).toContain("overflow-hidden");
  });
});

/**
 * A footer Cancel button lives inside the dialog, so wiring it to the caller's own
 * `onClose` skips the unsaved-changes confirmation that the scrim, Escape and the
 * X all honour. `useModalDismiss` is how such a child reaches the guarded close.
 */
describe("useModalDismiss", () => {
  function DismissButton() {
    const dismiss = useModalDismiss();
    return <button type="button" onClick={dismiss}>Cancel</button>;
  }

  it("routes a child's dismissal through the unsaved-changes guard", () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose} title="Edit contact" hasUnsavedChanges>
        <DismissButton />
      </Modal>,
    );

    fireEvent.click(screen.getByText("Cancel"));

    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes straight through when there is nothing to lose", () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose} title="Edit contact">
        <DismissButton />
      </Modal>,
    );

    fireEvent.click(screen.getByText("Cancel"));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is inert outside a Modal rather than throwing", () => {
    render(<DismissButton />);
    expect(() => fireEvent.click(screen.getByText("Cancel"))).not.toThrow();
  });
});

describe("Modal dialog semantics", () => {
  it("marks the surface as a modal dialog named by its headline", () => {
    render(
      <Modal isOpen onClose={vi.fn()} title="Edit contact">
        <p>body</p>
      </Modal>,
    );
    const dialog = surface();
    expect(dialog.getAttribute("aria-modal")).toBe("true");

    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe("Edit contact");
  });

  it("falls back to ariaLabel when the modal has no visible title", () => {
    render(
      <Modal isOpen onClose={vi.fn()} ariaLabel="Chrome extension setup">
        <p>body</p>
      </Modal>,
    );
    const dialog = surface();
    expect(dialog.getAttribute("aria-label")).toBe("Chrome extension setup");
    expect(dialog.getAttribute("aria-labelledby")).toBeNull();
  });

  it("gives the icon-only close button an accessible name", () => {
    render(
      <Modal isOpen onClose={vi.fn()} title="Edit contact">
        <p>body</p>
      </Modal>,
    );
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });
});

/**
 * The unsaved-changes dialog is a second dialog, rendered as a DOM sibling of the
 * modal surface rather than a child. That is what lets the two traps coexist: a
 * keydown inside this one never bubbles through the modal's handler.
 */
describe("ConfirmDiscardDialog focus trap", () => {
  const openConfirm = () => {
    render(
      <Modal isOpen onClose={vi.fn()} title="Edit contact" hasUnsavedChanges>
        <button type="button">body control</button>
      </Modal>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    return screen.getByRole("alertdialog");
  };

  it("takes focus on the least destructive action", () => {
    openConfirm();
    // APG: focus the least destructive action on an irreversible operation.
    expect(document.activeElement).toBe(screen.getByText("Keep editing"));
  });

  it("names and describes itself", () => {
    const confirm = openConfirm();
    expect(confirm.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(confirm.getAttribute("aria-labelledby")!)?.textContent).toBe(
      "Unsaved changes",
    );
    expect(document.getElementById(confirm.getAttribute("aria-describedby")!)?.textContent).toBe(
      "You have unsaved changes that will be lost.",
    );
  });

  it("cycles within itself rather than back into the modal underneath", () => {
    openConfirm();
    screen.getByText("Discard").focus();

    tab();

    expect(document.activeElement).toBe(screen.getByText("Keep editing"));
    expect(document.activeElement).not.toBe(screen.getByText("body control"));
  });

  it("hands focus back into the modal when dismissed", () => {
    openConfirm();
    fireEvent.click(screen.getByText("Keep editing"));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });
});
