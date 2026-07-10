// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { AiUnavailableNotice } from "@/components/ai/ai-unavailable-notice";
import { AI_FAILURE_COPY, type AiFailureCode } from "@/lib/ai-errors";

const CODES: AiFailureCode[] = [
  "ai_no_key",
  "ai_key_invalid",
  "ai_quota_exhausted",
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
});
