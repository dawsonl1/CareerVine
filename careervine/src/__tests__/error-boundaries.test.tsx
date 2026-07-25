// @vitest-environment jsdom
/**
 * Error boundary tests (CAR-184).
 *
 * Covers the three behaviors the ticket asked for (fallback instead of a blank
 * tree, retry re-renders the child, a sibling section survives) plus two the
 * research earned:
 *
 *  - `notFound()` must be RE-THROWN, not swallowed. This is the property that
 *    justified building SectionBoundary on Next's `unstable_catchError` instead of
 *    a hand-rolled class, so it is pinned here: swap the implementation for a naive
 *    class boundary and this test goes red.
 *  - `unstable_catchError` must still be exported from `next/error`. It carries an
 *    `unstable_` prefix, so a Next bump could rename it. That should fail a test
 *    rather than break production.
 *
 * React logs every caught error through `console.error`, and rendering
 * global-error's `<html>` into a jsdom container adds nesting warnings. Each test
 * that trips a boundary installs its own spy and restores it, so the suite stays
 * quiet without globally muting a real signal. `boundaryLogs()` filters that spy
 * down to the reporter's own lines, which is also how the reporting seam is
 * asserted end to end (no module mock, so there is nothing to drift).
 */
import { describe, it, expect, vi, afterEach, type MockInstance } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { useState } from "react";
import { notFound } from "next/navigation";
import * as nextError from "next/error";
// Deep Next imports, deliberately. `unstable_catchError` reads AppRouterContext for
// its retry and PathnameContext for its auto-clear; without providing them a test
// cannot tell `unstable_retry()` from `reset()`, nor exercise the pathname reset at
// all. Asserting on the real contexts is the only way to pin either behavior.
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { SectionBoundary } from "@/components/ui/section-boundary";
import { reportBoundaryError } from "@/lib/report-error";
import RootError from "@/app/error";
import AdminError from "@/app/admin/error";
import GlobalError from "@/app/global-error";

// app/error.tsx renders <Navigation />, which calls useAuth() and throws outside
// AuthProvider by design. In the app it always renders inside that provider; here
// it only needs to be present and inert.
vi.mock("@/components/navigation", () => ({
  default: () => <nav data-testid="nav" />,
}));

/** Only the reporter's own lines, not React's caught-error or nesting noise. */
function boundaryLogs(spy: MockInstance<typeof console.error>) {
  return spy.mock.calls.filter(
    (call) => typeof call[0] === "string" && call[0].startsWith("[boundary]")
  );
}

function quietConsole() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

function Boom({ shouldThrow, message = "kaboom" }: { shouldThrow: boolean; message?: string }) {
  if (shouldThrow) throw new Error(message);
  return <p>child rendered</p>;
}

/** Throws on first render; the button fixes the child, then Try again recovers it. */
function RecoverableSection() {
  const [broken, setBroken] = useState(true);
  return (
    <>
      <button onClick={() => setBroken(false)}>fix the data</button>
      <SectionBoundary label="recoverable">
        <Boom shouldThrow={broken} />
      </SectionBoundary>
    </>
  );
}

afterEach(cleanup);

describe("SectionBoundary", () => {
  it("renders the fallback instead of a blank tree when a child throws", () => {
    const spy = quietConsole();
    const { container } = render(
      <SectionBoundary label="inbox-tab:drafts">
        <Boom shouldThrow />
      </SectionBoundary>
    );

    expect(screen.getByText("Something went wrong loading this section.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText("child rendered")).toBeNull();
    // The blast radius is what this ticket is about: something is on screen.
    expect(container.textContent).not.toBe("");
    spy.mockRestore();
  });

  it("puts role=alert on the message only, never wrapping the button", () => {
    const spy = quietConsole();
    render(
      <SectionBoundary>
        <Boom shouldThrow />
      </SectionBoundary>
    );

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Something went wrong loading this section.");
    expect(alert.querySelector("button")).toBeNull();
    spy.mockRestore();
  });

  it("re-renders the child when Try again is pressed after the cause is fixed", () => {
    const spy = quietConsole();
    render(<RecoverableSection />);

    expect(screen.getByText("Something went wrong loading this section.")).toBeTruthy();

    fireEvent.click(screen.getByText("fix the data"));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(screen.getByText("child rendered")).toBeTruthy();
    expect(screen.queryByText("Something went wrong loading this section.")).toBeNull();
    spy.mockRestore();
  });

  it("keeps a sibling section rendering when one section's boundary trips", () => {
    const spy = quietConsole();
    render(
      <div>
        <SectionBoundary label="broken">
          <Boom shouldThrow />
        </SectionBoundary>
        <SectionBoundary label="healthy">
          <Boom shouldThrow={false} />
        </SectionBoundary>
      </div>
    );

    expect(screen.getByText("Something went wrong loading this section.")).toBeTruthy();
    expect(screen.getByText("child rendered")).toBeTruthy();
    spy.mockRestore();
  });

  it("runs onReset before retrying, so the caller can clear the bad state", () => {
    const spy = quietConsole();
    const calls: string[] = [];
    function Section() {
      const [broken, setBroken] = useState(true);
      return (
        <SectionBoundary
          label="with-reset"
          onReset={() => {
            calls.push("onReset");
            setBroken(false);
          }}
        >
          <Boom shouldThrow={broken} />
        </SectionBoundary>
      );
    }

    render(<Section />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(calls).toEqual(["onReset"]);
    // onReset cleared the cause, so the retry recovers in the same click.
    expect(screen.getByText("child rendered")).toBeTruthy();
    spy.mockRestore();
  });

  it("honors a custom fallback node and a custom message", () => {
    const spy = quietConsole();
    const { unmount } = render(
      <SectionBoundary fallback={<p>custom fallback</p>}>
        <Boom shouldThrow />
      </SectionBoundary>
    );
    expect(screen.getByText("custom fallback")).toBeTruthy();
    expect(screen.queryByText("Something went wrong loading this section.")).toBeNull();
    unmount();

    render(
      <SectionBoundary message="This tab could not be loaded.">
        <Boom shouldThrow />
      </SectionBoundary>
    );
    expect(screen.getByText("This tab could not be loaded.")).toBeTruthy();
    spy.mockRestore();
  });

  it("reports the caught error once, tagged with its label", () => {
    const spy = quietConsole();
    render(
      <SectionBoundary label="calendar-week-grid">
        <Boom shouldThrow message="bad date" />
      </SectionBoundary>
    );

    const logs = boundaryLogs(spy);
    expect(logs).toHaveLength(1);
    expect(logs[0][0]).toContain("section:calendar-week-grid");
    expect((logs[0][1] as Error).message).toBe("bad date");
    spy.mockRestore();
  });

  it("re-throws notFound() instead of swallowing it", () => {
    // A hand-rolled class boundary would catch this sentinel and show an error
    // panel where the user should have seen the not-found route. This is the
    // property that picked the implementation, so it is pinned.
    const spy = quietConsole();
    function NotFoundThrower(): React.ReactNode {
      notFound();
    }

    let thrown: unknown;
    try {
      render(
        <SectionBoundary label="dynamic">
          <NotFoundThrower />
        </SectionBoundary>
      );
    } catch (e) {
      thrown = e;
    }
    // Assert it is the ROUTER sentinel specifically. A bare `.toThrow()` would
    // also pass if the boundary threw for some unrelated reason, which is the
    // opposite of the property under test.
    expect((thrown as { digest?: string } | undefined)?.digest).toContain(
      "NEXT_HTTP_ERROR_FALLBACK;404"
    );
    expect(screen.queryByText("Something went wrong loading this section.")).toBeNull();
    spy.mockRestore();
  });

  it("moves focus to the panel so Try again is reachable from the keyboard", () => {
    // A trip destroys the focused element inside the subtree, dropping focus to
    // <body>; without this a keyboard user tabs the whole page to reach recovery.
    const spy = quietConsole();
    render(
      <SectionBoundary label="focus">
        <Boom shouldThrow />
      </SectionBoundary>
    );

    const panel = screen.getByRole("alert").parentElement;
    expect(document.activeElement).toBe(panel);
    expect(document.activeElement).not.toBe(document.body);
    spy.mockRestore();
  });
});

describe("SectionBoundary recovery semantics", () => {
  // These are the tests that distinguish this implementation from a hand-rolled
  // class boundary. Without the real Next contexts, `unstable_retry()` silently
  // degrades to `reset()` and the pathname auto-clear never runs, so a suite
  // without them stays green even if both properties are removed.

  it("unstable_retry() refreshes the router, not just the error state", () => {
    const spy = quietConsole();
    const refresh = vi.fn();

    render(
      <AppRouterContext.Provider
        value={{ refresh } as unknown as React.ContextType<typeof AppRouterContext>}
      >
        <SectionBoundary label="retry">
          <Boom shouldThrow />
        </SectionBoundary>
      </AppRouterContext.Provider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    // Swapping `unstable_retry()` for `reset()` in section-boundary.tsx leaves
    // every other test in this file green; this one goes red.
    expect(refresh).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("clears the error when the pathname changes", () => {
    const spy = quietConsole();

    function AtPath({ pathname, broken }: { pathname: string; broken: boolean }) {
      return (
        <PathnameContext.Provider value={pathname}>
          <SectionBoundary label="nav">
            <Boom shouldThrow={broken} />
          </SectionBoundary>
        </PathnameContext.Provider>
      );
    }

    const { rerender } = render(<AtPath pathname="/contacts/1" broken />);
    expect(screen.getByText("Something went wrong loading this section.")).toBeTruthy();

    // Same boundary element, new route: the error must not follow the user.
    rerender(<AtPath pathname="/contacts/2" broken={false} />);
    expect(screen.getByText("child rendered")).toBeTruthy();
    expect(screen.queryByText("Something went wrong loading this section.")).toBeNull();
    spy.mockRestore();
  });

  it("keeps the error across a SAME-route section switch, which is why the adoption sites pass a key", () => {
    // This is the exact stuck-panel bug the `key` at the inbox and contact-detail
    // sites prevents. Deleting those keys must fail a test rather than shipping a
    // permanently stuck panel, and a reviewer's instinct is to call a key on a
    // single child redundant, so both halves are pinned here.
    const spy = quietConsole();

    function Tabs({ tab, keyed }: { tab: string; keyed: boolean }) {
      const boundary = (
        <SectionBoundary key={keyed ? tab : undefined} label="tabs">
          {tab === "a" && <Boom shouldThrow />}
          {tab === "b" && <p>tab b content</p>}
        </SectionBoundary>
      );
      // Pathname never changes, so the boundary's own auto-clear cannot help.
      return <PathnameContext.Provider value="/inbox">{boundary}</PathnameContext.Provider>;
    }

    // Unkeyed: the boundary instance survives the switch, so the panel sticks.
    const unkeyed = render(<Tabs tab="a" keyed={false} />);
    expect(screen.getByText("Something went wrong loading this section.")).toBeTruthy();
    unkeyed.rerender(<Tabs tab="b" keyed={false} />);
    expect(screen.getByText("Something went wrong loading this section.")).toBeTruthy();
    expect(screen.queryByText("tab b content")).toBeNull();
    unkeyed.unmount();

    // Keyed: the switch remounts the boundary, so the healthy tab renders.
    const keyed = render(<Tabs tab="a" keyed />);
    expect(screen.getByText("Something went wrong loading this section.")).toBeTruthy();
    keyed.rerender(<Tabs tab="b" keyed />);
    expect(screen.getByText("tab b content")).toBeTruthy();
    expect(screen.queryByText("Something went wrong loading this section.")).toBeNull();
    spy.mockRestore();
  });

  it("clears the error when a generation key changes, which is how fresh data recovers", () => {
    // The contact-detail site keys on `${activeTab}:${dataGeneration}` because
    // nothing there unmounts the boundary during a refresh. This pins that a
    // generation bump alone recovers the section, so healthy data cannot leave a
    // stale panel on screen.
    const spy = quietConsole();

    function Section({ generation, broken }: { generation: number; broken: boolean }) {
      return (
        <PathnameContext.Provider value="/contacts/1">
          <SectionBoundary key={`timeline:${generation}`} label="gen">
            <Boom shouldThrow={broken} />
          </SectionBoundary>
        </PathnameContext.Provider>
      );
    }

    const { rerender } = render(<Section generation={0} broken />);
    expect(screen.getByText("Something went wrong loading this section.")).toBeTruthy();

    rerender(<Section generation={1} broken={false} />);
    expect(screen.getByText("child rendered")).toBeTruthy();
    spy.mockRestore();
  });
});

describe("next/error contract", () => {
  it("still exports unstable_catchError", () => {
    // Guards the `unstable_` prefix: a Next rename must fail here, loudly,
    // instead of surfacing as a broken boundary in production.
    expect(typeof nextError.unstable_catchError).toBe("function");
  });
});

describe("route boundaries", () => {
  it("app/error.tsx renders a retryable panel and keeps navigation on screen", () => {
    const spy = quietConsole();
    const retry = vi.fn();
    const error = Object.assign(new Error("page blew up"), { digest: "abc123" });

    render(<RootError error={error} unstable_retry={retry} />);

    expect(screen.getByRole("alert").textContent).toBe("Something went wrong.");
    expect(screen.getByTestId("nav")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);

    const logs = boundaryLogs(spy);
    expect(logs).toHaveLength(1);
    expect(logs[0][0]).toContain("root");
    expect(logs[0][0]).toContain("digest=abc123");
    spy.mockRestore();
  });

  it("app/error.tsx offers a way out of the error, not just a retry", () => {
    const spy = quietConsole();
    render(<RootError error={new Error("x")} unstable_retry={vi.fn()} />);
    expect(screen.getByRole("link", { name: "Go to Home" }).getAttribute("href")).toBe("/");
    spy.mockRestore();
  });

  it("app/admin/error.tsx renders its own panel without a second Navigation", () => {
    const spy = quietConsole();
    const retry = vi.fn();

    render(<AdminError error={new Error("admin blew up")} unstable_retry={retry} />);

    expect(screen.getByRole("alert").textContent).toBe("Something went wrong.");
    // The admin layout already renders Navigation above this boundary.
    expect(screen.queryByTestId("nav")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(boundaryLogs(spy)[0][0]).toContain("admin");
    spy.mockRestore();
  });

  it("app/global-error.tsx renders its own html, body, title and viewport", () => {
    // Asserted on the server markup: global-error replaces the root layout, so
    // "does it render a document" is a structural claim, and jsdom would only
    // report nesting warnings for <html> inside a container div.
    const markup = renderToStaticMarkup(<GlobalError error={new Error("layout blew up")} />);

    expect(markup).toContain("<html");
    expect(markup).toContain("<body");
    expect(markup).toContain("Something went wrong.");
    expect(markup).toContain("Reload the page");
    // Next renders the document head INSIDE the boundary this file replaces, so
    // the default viewport meta unmounts with it. Without re-declaring it the page
    // renders scaled down on mobile, on the one screen that must stay readable.
    expect(markup).toContain('name="viewport"');
  });

  it("app/global-error.tsx really reloads the document rather than soft-retrying", () => {
    // The copy promises a reload. `unstable_retry()` is only a soft router refresh:
    // the JS bundle, module singletons and any corrupted localStorage all survive,
    // so for the failures that reach THIS boundary it usually re-renders the same
    // panel and the button reads as broken.
    const spy = quietConsole();
    const reload = vi.fn();
    const realLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...realLocation, reload },
    });

    try {
      render(<GlobalError error={Object.assign(new Error("boom"), { digest: "d9" })} />);
      fireEvent.click(screen.getByRole("button", { name: "Reload the page" }));
      expect(reload).toHaveBeenCalledTimes(1);

      const logs = boundaryLogs(spy);
      expect(logs).toHaveLength(1);
      expect(logs[0][0]).toContain("global");
      expect(logs[0][0]).toContain("digest=d9");
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: realLocation,
      });
      spy.mockRestore();
    }
  });

  it("app/global-error.tsx offers a provider-free way out, not just a retry", () => {
    // A root-layout failure can be deterministic, so a lone retry button leaves the
    // user stuck. A plain anchor needs no router, providers or stylesheet.
    const markup = renderToStaticMarkup(<GlobalError error={new Error("x")} />);
    expect(markup).toContain('href="/"');
    expect(markup).toContain("Go to Home");
  });

  it("app/global-error.tsx imports nothing that presumes the root layout survived", async () => {
    // It renders in place of the root layout, so the design system, the global
    // stylesheet and all eight context providers must be presumed dead. A
    // @/components import here is the classic way this page ships unstyled.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/app/global-error.tsx", "utf8");
    // Anchored to real import statements: an unanchored `from "…"` also matches
    // prose inside the file's own header comment.
    const importsOf = (text: string) =>
      [...text.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);

    expect(importsOf(source)).toEqual(["react", "@/lib/report-error"]);

    // The check above is only one level deep, so the invariant also has to hold for
    // the one module global-error does import. Its own header prescribes the edit
    // that would break this ("install @sentry/nextjs, then call captureException
    // here"), which would pull a browser SDK into the last-resort document with
    // nothing below it to catch a failure in that SDK's module init.
    const reporter = readFileSync("src/lib/report-error.ts", "utf8");
    expect(importsOf(reporter)).toEqual([]);
    expect(reporter).not.toMatch(/^import\s/m);
    expect(reporter).not.toMatch(/\brequire\(/);
  });
});

describe("adoption sites keep their reset signal", () => {
  // The test above pins the PROPERTY (unkeyed sticks, keyed clears) but cannot see
  // the call sites, so deleting a site's key would still leave the suite green while
  // shipping a permanently stuck panel. A `key` on what looks like a single child
  // reads as noise, so that deletion is a realistic review outcome. These are
  // source-level tripwires, in the same spirit as the global-error import assertion.
  const SITES_NEEDING_A_KEY = [
    "src/components/email/inbox/inbox-shell.tsx",
    "src/app/contacts/[id]/page.tsx",
  ];

  it.each(SITES_NEEDING_A_KEY)("%s keys its SectionBoundary", async (file) => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(file, "utf8");
    const at = source.indexOf("<SectionBoundary");
    expect(at, `${file} no longer wraps anything in SectionBoundary`).toBeGreaterThan(-1);

    // A fixed window rather than a tag regex: the opening tag contains `=>` inside
    // onReset, so a `[^>]*` match would stop short of the props.
    const openingTag = source.slice(at, at + 400);
    expect(
      /\bkey=/.test(openingTag),
      `${file} dropped the key on its SectionBoundary. Sections switch here by same-route state, so the boundary's pathname auto-clear cannot help and a tripped section would keep showing its error panel after the user switched away. See section-boundary.tsx's header.`,
    ).toBe(true);
  });

  it.each([
    "src/components/email/inbox/inbox-shell.tsx",
    "src/app/calendar/page.tsx",
    "src/app/contacts/[id]/page.tsx",
  ])("%s wires onReset so Try again can re-fetch", async (file) => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(file, "utf8");
    const at = source.indexOf("<SectionBoundary");
    const openingTag = source.slice(at, at + 400);
    expect(
      /\bonReset=/.test(openingTag),
      `${file} dropped onReset. Without it the retry re-renders the same parent-held data and throws again, so "Try again" is a no-op. See the RECOVERY CONTRACT in section-boundary.tsx.`,
    ).toBe(true);
  });
});

describe("boundary copy", () => {
  it("uses no em dashes anywhere a user can read (rule 35)", () => {
    const spy = quietConsole();

    const section = render(
      <SectionBoundary>
        <Boom shouldThrow />
      </SectionBoundary>
    );
    expect(section.container.textContent).not.toContain("—");
    section.unmount();

    const root = render(<RootError error={new Error("x")} unstable_retry={vi.fn()} />);
    expect(root.container.textContent).not.toContain("—");
    root.unmount();

    const admin = render(<AdminError error={new Error("x")} unstable_retry={vi.fn()} />);
    expect(admin.container.textContent).not.toContain("—");
    admin.unmount();

    expect(
      renderToStaticMarkup(<GlobalError error={new Error("x")} />)
    ).not.toContain("—");

    spy.mockRestore();
  });

  it("never puts a stack trace or an error code in the UI", () => {
    const spy = quietConsole();
    const error = Object.assign(new Error("secret internal detail"), { digest: "abc123" });

    const root = render(<RootError error={error} unstable_retry={vi.fn()} />);
    expect(root.container.textContent).not.toContain("secret internal detail");
    expect(root.container.textContent).not.toContain("abc123");
    root.unmount();

    render(
      <SectionBoundary label="x">
        <Boom shouldThrow message="secret internal detail" />
      </SectionBoundary>
    );
    expect(screen.queryByText(/secret internal detail/)).toBeNull();
    spy.mockRestore();
  });
});

describe("reportBoundaryError", () => {
  it("prefixes every line with [boundary] and the scope", () => {
    const spy = quietConsole();
    reportBoundaryError("section", new Error("e"), { label: "inbox-tab:drafts" });
    expect(boundaryLogs(spy)[0][0]).toBe("[boundary] section:inbox-tab:drafts");
    spy.mockRestore();
  });

  it("picks up a digest off the error when none is passed explicitly", () => {
    const spy = quietConsole();
    reportBoundaryError("root", Object.assign(new Error("e"), { digest: "zz9" }));
    expect(boundaryLogs(spy)[0][0]).toBe("[boundary] root digest=zz9");
    spy.mockRestore();
  });

  it("never throws, even on a non-Error value", () => {
    const spy = quietConsole();
    expect(() => reportBoundaryError("global", "just a string")).not.toThrow();
    expect(() => reportBoundaryError("section", null)).not.toThrow();
    spy.mockRestore();
  });
});
