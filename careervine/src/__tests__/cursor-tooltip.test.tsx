// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { CursorTooltip, useCursorTooltip } from "@/components/ui/cursor-tooltip";

afterEach(cleanup);

describe("CursorTooltip", () => {
  it("renders children into document.body offset from the cursor when visible", () => {
    render(
      <div data-testid="host">
        <CursorTooltip visible initialX={100} initialY={200}>
          <span>Incoming — sent to you</span>
        </CursorTooltip>
      </div>
    );
    const tip = screen.getByText("Incoming — sent to you").parentElement!;
    expect(tip.parentElement).toBe(document.body);
    expect(tip.style.left).toBe("114px");
    expect(tip.style.top).toBe("214px");
  });

  it("renders nothing when not visible", () => {
    render(
      <CursorTooltip visible={false} initialX={0} initialY={0}>
        <span>hidden</span>
      </CursorTooltip>
    );
    expect(screen.queryByText("hidden")).toBeNull();
  });
});

describe("useCursorTooltip", () => {
  function Harness() {
    const { posRef, tooltipRef, handleMouseMove } = useCursorTooltip();
    return (
      <div data-testid="area" onMouseMove={handleMouseMove}>
        <div data-testid="pos">{`${posRef.current.x},${posRef.current.y}`}</div>
        <div data-testid="tip" ref={tooltipRef} style={{ position: "fixed" }} />
      </div>
    );
  }

  it("tracks the cursor and repositions the tooltip element directly", () => {
    render(<Harness />);
    fireEvent.mouseMove(screen.getByTestId("area"), { clientX: 50, clientY: 120 });
    const tip = screen.getByTestId("tip");
    expect(tip.style.left).toBe("64px"); // clientX + 14
    // top = clientY - offsetHeight - 8; offsetHeight is 0 in jsdom
    expect(tip.style.top).toBe("112px");
  });
});
