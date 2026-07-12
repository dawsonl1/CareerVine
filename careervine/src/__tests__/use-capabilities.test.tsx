// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { useCapabilities, invalidateCapabilitiesCache } from "@/hooks/use-capabilities";
import { Capable } from "@/components/capable";

/** CAR-103: the client store + <Capable> gate reflect the server capability set,
 *  and fail closed (free) when the fetch errors. */

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { id: "u-1" } }),
}));

function Probe() {
  const { can, loading } = useCapabilities();
  return (
    <div>
      <span>{loading ? "loading" : "ready"}</span>
      <span>{can("inbox:premium") ? "premium" : "free"}</span>
      <Capable capability="mailbox:read" fallback={<span>no-mailbox</span>}>
        <span>has-mailbox</span>
      </Capable>
    </div>
  );
}

describe("useCapabilities store + Capable gate", () => {
  beforeEach(() => {
    invalidateCapabilitiesCache();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("resolves capabilities from /api/capabilities and reflects them in can() + Capable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ capabilities: ["inbox:premium", "mailbox:read"] }) })),
    );
    render(<Probe />);
    await waitFor(() => expect(screen.getByText("ready")).toBeTruthy());
    expect(screen.getByText("premium")).toBeTruthy();
    expect(screen.getByText("has-mailbox")).toBeTruthy();
  });

  it("fails closed (free, empty set) when the fetch errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
    render(<Probe />);
    await waitFor(() => expect(screen.getByText("ready")).toBeTruthy());
    expect(screen.getByText("free")).toBeTruthy();
    expect(screen.getByText("no-mailbox")).toBeTruthy();
  });
});
