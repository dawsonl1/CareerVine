// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";

/**
 * CAR-103: EmailExperience is the single Inbox/Outreach branch point. Mock
 * next/dynamic (its loader resolves directly to the shell component via
 * .then(m => m.Shell)) and the two shells, then drive the branch via a mocked
 * useCapabilities.
 */

vi.mock("next/dynamic", () => ({
  __esModule: true,
  default: (loader: () => Promise<unknown>) => {
    const Dynamic = (props: Record<string, unknown>) => {
      const [Comp, setComp] = React.useState<React.ComponentType | null>(null);
      React.useEffect(() => {
        let active = true;
        Promise.resolve(loader()).then((resolved) => {
          if (!active) return;
          const c = (resolved as { default?: React.ComponentType }).default ?? (resolved as React.ComponentType);
          setComp(() => c);
        });
        return () => {
          active = false;
        };
      }, []);
      return Comp ? React.createElement(Comp, props) : null;
    };
    return Dynamic;
  },
}));

vi.mock("@/components/email/inbox/inbox-shell", () => ({ InboxShell: () => <div>inbox-shell</div> }));
vi.mock("@/components/email/outreach/outreach-shell", () => ({ OutreachShell: () => <div>outreach-shell</div> }));

const capsState: { loading: boolean; can: (c: string) => boolean } = { loading: false, can: () => false };
vi.mock("@/hooks/use-capabilities", () => ({ useCapabilities: () => capsState }));

import { EmailExperience } from "@/components/email/email-experience";

describe("EmailExperience — Inbox/Outreach branch point", () => {
  beforeEach(() => {
    capsState.loading = false;
    capsState.can = () => false;
  });
  afterEach(() => cleanup());

  it("shows the skeleton while capabilities are loading (never the wrong shell)", () => {
    capsState.loading = true;
    render(<EmailExperience />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByText("inbox-shell")).toBeNull();
    expect(screen.queryByText("outreach-shell")).toBeNull();
  });

  it("defaults to the premium Inbox shell when there is no free-tier grant (unconnected / error / pre-migration all land here)", async () => {
    capsState.can = () => false;
    render(<EmailExperience />);
    await waitFor(() => expect(screen.getByText("inbox-shell")).toBeTruthy());
    expect(screen.queryByText("outreach-shell")).toBeNull();
  });

  it("renders the Outreach shell only on a positive outreach:portal grant", async () => {
    capsState.can = (c) => c === "outreach:portal";
    render(<EmailExperience />);
    await waitFor(() => expect(screen.getByText("outreach-shell")).toBeTruthy());
    expect(screen.queryByText("inbox-shell")).toBeNull();
  });
});
