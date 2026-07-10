// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Modal } from "@/components/ui/modal";

afterEach(cleanup);

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
