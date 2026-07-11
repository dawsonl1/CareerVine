// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ConfirmDialog } from "@/components/onboarding/onboarding-flow";

afterEach(cleanup);

const base = {
  title: "Are you sure you want to cancel the onboarding?",
  body: "It only takes about 4 minutes.",
  stayLabel: "Keep going",
  leaveLabel: "Cancel onboarding",
};

describe("ConfirmDialog (onboarding exit guard, CAR-84)", () => {
  it("renders the title, body, and both labels", () => {
    render(<ConfirmDialog {...base} onStay={() => {}} onLeave={() => {}} />);
    expect(screen.getByText(base.title)).toBeTruthy();
    expect(screen.getByText(base.body)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep going" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel onboarding" })).toBeTruthy();
  });

  it("fires onLeave only from the leave button, onStay only from the stay button", () => {
    const onStay = vi.fn();
    const onLeave = vi.fn();
    render(<ConfirmDialog {...base} onStay={onStay} onLeave={onLeave} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel onboarding" }));
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(onStay).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Keep going" }));
    expect(onStay).toHaveBeenCalledTimes(1);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("treats a scrim click as staying (never an accidental exit)", () => {
    const onStay = vi.fn();
    const onLeave = vi.fn();
    const { container } = render(<ConfirmDialog {...base} onStay={onStay} onLeave={onLeave} />);
    const scrim = container.querySelector(".bg-black\\/60");
    fireEvent.click(scrim as Element);
    expect(onStay).toHaveBeenCalledTimes(1);
    expect(onLeave).not.toHaveBeenCalled();
  });
});
