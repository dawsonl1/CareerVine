// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useScrollRestoration } from "@/hooks/use-scroll-restoration";
import {
  rememberScroll,
  recallScroll,
  rememberAnchor,
  consumeAnchor,
  setLastPopAtForTest,
} from "@/lib/scroll-memory";

/**
 * CAR-256. The e2e flow proves this end to end in a real browser; these cover
 * the decision table, which is where the bugs are. Every restore is gated on
 * three independent conditions and each has to be able to say no on its own:
 * the mount followed a popstate, the content is at full height, and the browser
 * has not already put the page back itself.
 *
 * The recording half matters just as much and is easier to get wrong: the first
 * version of this hook recorded unconditionally, and the scroll Next performs on
 * the OUTGOING page overwrote the real offset with 0.
 */

const PATH = "/companies";

/** jsdom has no layout, so give the document something to scroll. */
function setScrollable(y: number) {
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  Object.defineProperty(window, "scrollY", { value: y, writable: true, configurable: true });
}

/**
 * A row the anchor can find, with the layout jsdom does not compute. `top`/
 * `bottom` are viewport-relative, i.e. what the offset restore left behind.
 */
function anchoredRow(id: string, top: number, height = 100) {
  const el = document.createElement("div");
  el.setAttribute("data-scroll-anchor", id);
  el.getBoundingClientRect = () =>
    ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top }) as DOMRect;
  el.scrollIntoView = vi.fn();
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  sessionStorage.clear();
  setLastPopAtForTest(0);
  setScrollable(0);
  document.body.innerHTML = "";
  window.history.replaceState({}, "", PATH);
});
afterEach(cleanup);

describe("useScrollRestoration — restoring", () => {
  it("restores after a pop, when ready and the browser left it at the top", () => {
    rememberScroll(PATH, "", 900);
    setLastPopAtForTest(Date.now());

    renderHook(() => useScrollRestoration({ pathname: PATH, search: "", ready: true }));

    expect(window.scrollTo).toHaveBeenCalledWith(0, 900);
  });

  it("does not restore without a pop, so the nav bar still lands at the top", () => {
    rememberScroll(PATH, "", 900);
    // No setLastPopAtForTest: this mount is a forward navigation.

    renderHook(() => useScrollRestoration({ pathname: PATH, search: "", ready: true }));

    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it("does not restore while the content is not ready", () => {
    // `ready` is "came from cache". On a genuine refetch the document is one
    // viewport tall, so a restore would land nowhere and jumping the user after
    // they have waited is worse than the reset.
    rememberScroll(PATH, "", 900);
    setLastPopAtForTest(Date.now());

    renderHook(() => useScrollRestoration({ pathname: PATH, search: "", ready: false }));

    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it("stands down when the browser has already restored", () => {
    rememberScroll(PATH, "", 900);
    setLastPopAtForTest(Date.now());
    setScrollable(900);

    renderHook(() => useScrollRestoration({ pathname: PATH, search: "", ready: true }));

    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it("does nothing when there is no remembered position", () => {
    setLastPopAtForTest(Date.now());

    renderHook(() => useScrollRestoration({ pathname: PATH, search: "", ready: true }));

    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it("restores at most once, even if ready flips again", () => {
    rememberScroll(PATH, "", 900);
    setLastPopAtForTest(Date.now());

    const { rerender } = renderHook(
      ({ ready }: { ready: boolean }) => useScrollRestoration({ pathname: PATH, search: "", ready }),
      { initialProps: { ready: true } },
    );
    rerender({ ready: false });
    rerender({ ready: true });

    expect(window.scrollTo).toHaveBeenCalledTimes(1);
  });

  it("matches the remembered position to the filtered view it was taken in", () => {
    rememberScroll(PATH, "status=applied", 900);
    setLastPopAtForTest(Date.now());

    renderHook(() =>
      useScrollRestoration({ pathname: PATH, search: "status=closed", ready: true }),
    );

    expect(window.scrollTo).not.toHaveBeenCalled();
  });
});

/**
 * CAR-278. A write now refreshes the list in the background, so the rows behind
 * a remembered offset can have moved by the time the user comes back. The offset
 * still wins whenever it is right, because it reproduces the view exactly; the
 * anchor only rescues the case where it is not.
 */
describe("useScrollRestoration — anchors", () => {
  it("scrolls the row into view when the offset left it off screen", () => {
    rememberScroll(PATH, "", 900);
    rememberAnchor(PATH, "", "42");
    setLastPopAtForTest(Date.now());
    // The list came back reordered: the row is now far below the fold.
    const row = anchoredRow("42", 4000);

    renderHook(() => useScrollRestoration({ pathname: PATH, search: "", ready: true }));

    expect(window.scrollTo).toHaveBeenCalledWith(0, 900);
    expect(row.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
  });

  it("leaves the page alone when the offset already put the row on screen", () => {
    // The list did not change, so the offset reproduced the view exactly.
    // Re-centring here would move a page the user is already reading.
    rememberScroll(PATH, "", 900);
    rememberAnchor(PATH, "", "42");
    setLastPopAtForTest(Date.now());
    const row = anchoredRow("42", 200);

    renderHook(() => useScrollRestoration({ pathname: PATH, search: "", ready: true }));

    expect(window.scrollTo).toHaveBeenCalledWith(0, 900);
    expect(row.scrollIntoView).not.toHaveBeenCalled();
  });

  it("falls back to the offset when the row is gone entirely", () => {
    // Deleted, or filtered out of this view. Nothing to anchor to, so the
    // remembered offset stands rather than the page jumping somewhere arbitrary.
    rememberScroll(PATH, "", 900);
    rememberAnchor(PATH, "", "42");
    setLastPopAtForTest(Date.now());

    renderHook(() => useScrollRestoration({ pathname: PATH, search: "", ready: true }));

    expect(window.scrollTo).toHaveBeenCalledWith(0, 900);
  });

  it("rescues even when the browser restored the scroll itself", () => {
    // The `scrollY > 0` branch stands down from touching the offset, and it is
    // right to: Next already applied one. But Next measured it against the old
    // list too, so the row can still be in the wrong place.
    rememberScroll(PATH, "", 900);
    rememberAnchor(PATH, "", "42");
    setLastPopAtForTest(Date.now());
    setScrollable(900);
    const row = anchoredRow("42", -3000);

    renderHook(() => useScrollRestoration({ pathname: PATH, search: "", ready: true }));

    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(row.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
  });

  it("consumes the anchor on a mount that never restores", () => {
    // `ready: false` is a real refetch, where restoration deliberately declines.
    // The anchor must not survive it: the next pop onto this view belongs to a
    // different trip and would jump to a row the user had moved on from.
    rememberAnchor(PATH, "", "42");
    setLastPopAtForTest(Date.now());

    renderHook(() => useScrollRestoration({ pathname: PATH, search: "", ready: false }));

    expect(consumeAnchor(PATH, "")).toBeNull();
  });

  it("exposes rememberAnchor bound to the current view", () => {
    const { result } = renderHook(() =>
      useScrollRestoration({ pathname: PATH, search: "status=applied", ready: false }),
    );

    act(() => result.current.rememberAnchor("77"));

    expect(consumeAnchor(PATH, "status=applied")).toBe("77");
    expect(consumeAnchor(PATH, "status=closed")).toBeNull();
  });
});

describe("useScrollRestoration — recording", () => {
  it("records a scroll that happens on this view", async () => {
    renderHook(() => useScrollRestoration({ pathname: PATH, search: "", ready: false }));

    setScrollable(640);
    await act(async () => {
      window.dispatchEvent(new Event("scroll"));
      // The listener writes on a requestAnimationFrame.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });

    expect(recallScroll(PATH, "")).toBe(640);
  });

  it("records a scroll back to the top, which is a real thing a user does", async () => {
    rememberScroll(PATH, "", 640);
    renderHook(() => useScrollRestoration({ pathname: PATH, search: "", ready: false }));

    setScrollable(0);
    await act(async () => {
      window.dispatchEvent(new Event("scroll"));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });

    // Guarding recording on a non-zero offset would be wrong here: the user is
    // at the top and returning should put them at the top.
    expect(recallScroll(PATH, "")).toBe(0);
  });

  it("ignores the scroll-to-top Next performs on the page being left", async () => {
    // THE defect this guard exists for. Navigating to a company scrolls the
    // outgoing list to the top while it is still mounted; recording that 0 over
    // the real offset made the whole sessionStorage half inert.
    rememberScroll(PATH, "", 2006);
    renderHook(() => useScrollRestoration({ pathname: PATH, search: "", ready: false }));

    window.history.replaceState({}, "", "/companies/123");
    setScrollable(0);
    await act(async () => {
      window.dispatchEvent(new Event("scroll"));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });

    expect(recallScroll(PATH, "")).toBe(2006);
  });

  it("does not let unmount clobber the offset once the URL has moved on", () => {
    rememberScroll(PATH, "", 2006);
    const { unmount } = renderHook(() =>
      useScrollRestoration({ pathname: PATH, search: "", ready: false }),
    );

    window.history.replaceState({}, "", "/companies/123");
    setScrollable(0);
    unmount();

    expect(recallScroll(PATH, "")).toBe(2006);
  });

  it("captures a last scroll on unmount while still on the view", () => {
    const { unmount } = renderHook(() =>
      useScrollRestoration({ pathname: PATH, search: "", ready: false }),
    );

    setScrollable(1200);
    unmount();

    expect(recallScroll(PATH, "")).toBe(1200);
  });
});
