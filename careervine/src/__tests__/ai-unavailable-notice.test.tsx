// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { AiUnavailableNotice } from "@/components/ai/ai-unavailable-notice";
import { AI_FAILURE_COPY, type AiFailureCode } from "@/lib/ai-errors";
import { installFakeFetch } from "./helpers/fake-fetch";

const CODES: AiFailureCode[] = [
  "ai_no_key",
  "ai_key_invalid",
  "ai_quota_exhausted",
  "ai_trial_expired",
  "ai_unavailable",
];

afterEach(cleanup);

describe("AiUnavailableNotice", () => {
  it("renders the title + settings-linked CTA for every code", () => {
    for (const code of CODES) {
      const { unmount } = render(<AiUnavailableNotice code={code} />);
      expect(screen.getByText(AI_FAILURE_COPY[code].title)).toBeTruthy();
      const cta = screen.getByRole("link", { name: AI_FAILURE_COPY[code].ctaLabel });
      expect(cta.getAttribute("href")).toBe("/settings?tab=ai");
      unmount();
    }
  });

  it("shows Try again only when the code is retryable and onRetry is provided", () => {
    const onRetry = vi.fn();

    render(<AiUnavailableNotice code="ai_unavailable" onRetry={onRetry} />);
    const retry = screen.getByRole("button", { name: "Try again" });
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    cleanup();

    // Non-retryable code: no retry button even with a handler.
    render(<AiUnavailableNotice code="ai_no_key" onRetry={onRetry} />);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    cleanup();

    // Retryable code but no handler: no retry button.
    render(<AiUnavailableNotice code="ai_unavailable" />);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("shows Request AI access only for ai_trial_expired, and settles into a sent state", async () => {
    // Other codes must not grow the button.
    render(<AiUnavailableNotice code="ai_no_key" />);
    expect(screen.queryByRole("button", { name: "Request AI access" })).toBeNull();
    cleanup();

    // installFakeFetch rather than the older `{ ok: true }` object literal
    // (CONVENTIONS.md §h): the handler goes through apiSend as of CAR-188, and
    // apiSend's failure path reads res.status AND res.json(), neither of which
    // that literal carries. Asserted against it, the sibling failure test below
    // would have been proving the stub.
    const http = installFakeFetch({
      "POST /api/ai/request-access": { body: { success: true } },
    });

    render(<AiUnavailableNotice code="ai_trial_expired" />);
    const button = screen.getByRole("button", { name: "Request AI access" });
    fireEvent.click(button);

    expect(await screen.findByText(/Request sent/)).toBeTruthy();
    expect(http.countOf("POST /api/ai/request-access")).toBe(1);
    expect(http.unmatched).toEqual([]);
    expect(screen.queryByRole("button", { name: "Request AI access" })).toBeNull();

    vi.unstubAllGlobals();
  });

  it("surfaces a request failure and lets the user retry", async () => {
    const http = installFakeFetch({
      "POST /api/ai/request-access": { status: 500, body: { error: "boom" } },
    });

    render(<AiUnavailableNotice code="ai_trial_expired" />);
    fireEvent.click(screen.getByRole("button", { name: "Request AI access" }));

    expect(await screen.findByText(/Couldn't send/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Request AI access" })).toBeTruthy();
    expect(http.countOf("POST /api/ai/request-access")).toBe(1);
    expect(http.unmatched).toEqual([]);

    vi.unstubAllGlobals();
  });
});
