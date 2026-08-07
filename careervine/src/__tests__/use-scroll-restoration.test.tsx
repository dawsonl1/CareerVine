// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useScrollRestoration } from "@/hooks/use-scroll-restoration";
import { rememberScroll, recallScroll, setLastPopAtForTest } from "@/lib/scroll-memory";

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

beforeEach(() => {
  sessionStorage.clear();
  setLastPopAtForTest(0);
  setScrollable(0);
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
