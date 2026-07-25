// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import {
  DialogSurface,
  Modal,
  useModalDismiss,
  useModalPortalContainer,
} from "@/components/ui/modal";

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

  /**
   * CAR-197. React's `autoFocus` cannot express "open on this field": React strips
   * the attribute and focuses imperatively during commit, so this effect — which
   * runs after — always won, and every form dialog opened on its close button
   * instead of its first field. `data-autofocus` is the marker that survives to
   * the DOM for the trap to find.
   */
  it("opens on the control marked data-autofocus rather than the first tabbable", () => {
    render(
      <Modal isOpen onClose={vi.fn()} title="Edit contact">
        <input data-autofocus placeholder="name" />
      </Modal>,
    );
    expect(document.activeElement).toBe(screen.getByPlaceholderText("name"));
  });

  it("ignores the marker on a control that is not tabbable", () => {
    // Otherwise a marker left on a disabled field black-holes focus onto an
    // element that cannot hold it, dropping the user onto <body> outside the trap.
    render(
      <Modal isOpen onClose={vi.fn()} title="Edit contact">
        <input data-autofocus disabled placeholder="name" />
        <button type="button">reachable</button>
      </Modal>,
    );
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });

  it("still honours React's autoFocus nowhere, which is why the marker exists", () => {
    // Pins the premise of the two tests above. If a future React starts emitting
    // the attribute, this fails and the marker can be reconsidered.
    render(<input autoFocus placeholder="native" />);
    expect(screen.getByPlaceholderText("native").hasAttribute("autofocus")).toBe(false);
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

/**
 * `DialogSurface` is what `Modal` is built on, and what the four dialogs with
 * genuinely custom chrome render through (CAR-197). Everything below is behaviour
 * those four inherit and would otherwise have had to re-derive — which is exactly
 * how twelve dialogs ended up with no trap and no semantics at all.
 */
describe("DialogSurface", () => {
  const dialog = () => screen.getByRole("dialog");

  it("names itself from a heading id", () => {
    render(
      <DialogSurface isOpen onClose={vi.fn()} labelledBy="h">
        <h2 id="h">Log a conversation</h2>
      </DialogSurface>,
    );
    expect(dialog().getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(dialog().getAttribute("aria-labelledby")!)?.textContent).toBe(
      "Log a conversation",
    );
  });

  it("falls back to a literal label, and drops it once a heading is named", () => {
    const { rerender } = render(
      <DialogSurface isOpen onClose={vi.fn()} label="Guided onboarding">
        <p>step</p>
      </DialogSurface>,
    );
    expect(dialog().getAttribute("aria-label")).toBe("Guided onboarding");

    rerender(
      <DialogSurface isOpen onClose={vi.fn()} label="Guided onboarding" labelledBy="h">
        <h2 id="h">Welcome</h2>
      </DialogSurface>,
    );
    // Both at once would leave the announced name up to the AT to pick.
    expect(dialog().getAttribute("aria-label")).toBeNull();
    expect(dialog().getAttribute("aria-labelledby")).toBe("h");
  });

  it("takes role alertdialog and a description for a consequential question", () => {
    render(
      <DialogSurface isOpen onClose={vi.fn()} role="alertdialog" labelledBy="h" describedBy="b">
        <h2 id="h">Cancel the onboarding?</h2>
        <p id="b">It only takes four minutes.</p>
      </DialogSurface>,
    );
    const alert = screen.getByRole("alertdialog");
    expect(document.getElementById(alert.getAttribute("aria-describedby")!)?.textContent).toBe(
      "It only takes four minutes.",
    );
  });

  it("traps Tab inside the surface", () => {
    render(
      <>
        <button type="button">outside</button>
        <DialogSurface isOpen onClose={vi.fn()} label="Sheet">
          <button type="button">first</button>
          <button type="button">last</button>
        </DialogSurface>
      </>,
    );
    expect(document.activeElement).toBe(screen.getByText("first"));

    screen.getByText("last").focus();
    tab();

    expect(document.activeElement).toBe(screen.getByText("first"));
    expect(document.activeElement).not.toBe(screen.getByText("outside"));
  });

  it("restores focus to the trigger on close", () => {
    const Harness = ({ open }: { open: boolean }) => (
      <>
        <button type="button">trigger</button>
        {open && (
          <DialogSurface isOpen onClose={vi.fn()} label="Sheet">
            <button type="button">inside</button>
          </DialogSurface>
        )}
      </>
    );
    const { rerender } = render(<Harness open={false} />);
    const trigger = screen.getByText("trigger");
    trigger.focus();

    rerender(<Harness open />);
    rerender(<Harness open={false} />);

    expect(document.activeElement).toBe(trigger);
  });

  it("dismisses on the scrim and on Escape", () => {
    const onClose = vi.fn();
    const { container } = render(
      <DialogSurface isOpen onClose={onClose} label="Sheet" scrimClassName="scrim">
        <p>body</p>
      </DialogSurface>,
    );

    fireEvent.click(container.querySelector(".scrim")!);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("routes both of those through the unsaved-changes guard", () => {
    const onClose = vi.fn();
    const { container } = render(
      <DialogSurface isOpen onClose={onClose} label="Sheet" scrimClassName="scrim" hasUnsavedChanges>
        <p>body</p>
      </DialogSurface>,
    );

    fireEvent.click(container.querySelector(".scrim")!);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    fireEvent.click(screen.getByText("Discard"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /**
   * Guided onboarding. A stray click on the scrim or a reflexive Escape must not end
   * a run the user is four minutes into; the only way out is its own skip hatch,
   * which routes through a stay-nudge.
   */
  describe("dismissible={false}", () => {
    it("ignores the scrim and Escape", () => {
      const onClose = vi.fn();
      const { container } = render(
        <DialogSurface
          isOpen
          dismissible={false}
          onClose={onClose}
          label="Guided onboarding"
          scrimClassName="scrim"
        >
          <p>step</p>
        </DialogSurface>,
      );

      fireEvent.click(container.querySelector(".scrim")!);
      fireEvent.keyDown(document, { key: "Escape" });

      expect(onClose).not.toHaveBeenCalled();
    });

    it("still traps focus, because it is still a modal dialog", () => {
      render(
        <>
          <button type="button">outside</button>
          <DialogSurface isOpen dismissible={false} label="Guided onboarding">
            <button type="button">only</button>
          </DialogSurface>
        </>,
      );
      screen.getByText("only").focus();
      tab();
      expect(document.activeElement).toBe(screen.getByText("only"));
    });
  });

  /**
   * A nested confirmation has to be a DOM *sibling* of the surface. As a child its
   * keydowns would bubble through this surface's Tab handler and the two traps would
   * fight over every keypress.
   */
  it("renders `overlay` as a sibling of the surface, not inside it", () => {
    render(
      <DialogSurface
        isOpen
        onClose={vi.fn()}
        label="Sheet"
        overlay={<div data-testid="nested">confirm</div>}
      >
        <p>body</p>
      </DialogSurface>,
    );

    const nested = screen.getByTestId("nested");
    expect(dialog().contains(nested)).toBe(false);
    expect(nested.parentElement).toBe(dialog().parentElement);
  });

  /**
   * The reason a dialog cannot just add `useFocusTrap` locally: without this
   * provider every portalling child falls back to `document.body`, landing its menu
   * outside the trap that was just added.
   */
  it("publishes the surface as the portal container for its children", () => {
    let seen: HTMLElement | null = null;
    function Probe() {
      seen = useModalPortalContainer();
      return null;
    }
    render(
      <DialogSurface isOpen onClose={vi.fn()} label="Sheet">
        <Probe />
      </DialogSurface>,
    );
    expect(seen).toBe(dialog());
  });

  it("lets a child dismiss even when the ambient gestures are off", () => {
    // `dismissible` governs stray gestures, not a deliberate action by a control
    // inside the dialog.
    const onClose = vi.fn();
    function Skip() {
      const dismiss = useModalDismiss();
      return <button type="button" onClick={dismiss}>Skip</button>;
    }
    render(
      <DialogSurface isOpen dismissible={false} onClose={onClose} label="Guided onboarding">
        <Skip />
      </DialogSurface>,
    );

    fireEvent.click(screen.getByText("Skip"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("puts the caller's chrome on the wrapper, the scrim and the surface", () => {
    // Each of the four custom-chrome dialogs keeps its own z-index, alignment and
    // surface shape; swapping any of those onto the wrong element is invisible in
    // jsdom and obvious on screen.
    const { container } = render(
      <DialogSurface
        isOpen
        onClose={vi.fn()}
        label="Sheet"
        wrapperClassName="wrapper-chrome"
        scrimClassName="scrim-chrome"
        className="surface-chrome"
      >
        <p>body</p>
      </DialogSurface>,
    );

    expect(container.querySelector(".wrapper-chrome")).toBe(dialog().parentElement);
    expect(container.querySelector(".scrim-chrome")?.parentElement).toBe(dialog().parentElement);
    expect(dialog().className).toContain("surface-chrome");
  });

  it("renders nothing when closed", () => {
    render(
      <DialogSurface isOpen={false} onClose={vi.fn()} label="Sheet">
        <p>body</p>
      </DialogSurface>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
