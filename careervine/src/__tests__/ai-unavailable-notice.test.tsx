// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { AiUnavailableNotice } from "@/components/ai/ai-unavailable-notice";
import { AI_FAILURE_COPY, type AiFailureCode } from "@/lib/ai-errors";

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

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    render(<AiUnavailableNotice code="ai_trial_expired" />);
    const button = screen.getByRole("button", { name: "Request AI access" });
    fireEvent.click(button);

    expect(fetchMock).toHaveBeenCalledWith("/api/ai/request-access", { method: "POST" });
    expect(await screen.findByText(/Request sent/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Request AI access" })).toBeNull();

    vi.unstubAllGlobals();
  });

  it("surfaces a request failure and lets the user retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", fetchMock);

    render(<AiUnavailableNotice code="ai_trial_expired" />);
    fireEvent.click(screen.getByRole("button", { name: "Request AI access" }));

    expect(await screen.findByText(/Couldn't send/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Request AI access" })).toBeTruthy();

    vi.unstubAllGlobals();
  });
});
