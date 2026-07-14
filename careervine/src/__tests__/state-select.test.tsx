// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { StateSelect } from "@/components/ui/state-select";

afterEach(cleanup);

describe("StateSelect country-awareness", () => {
  it("renders a free-text State / Province input for non-US countries", () => {
    const onChange = vi.fn();
    render(<StateSelect country="Canada" value="Ontario" onChange={onChange} />);

    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("Ontario");
    expect(input.placeholder).toBe("State / Province");
    // No US dropdown trigger.
    expect(screen.queryByText("Select state")).toBeNull();

    fireEvent.change(input, { target: { value: "British Columbia" } });
    expect(onChange).toHaveBeenCalledWith("British Columbia");
  });

  it("renders the normalized state dropdown (no free-text input) for the US", () => {
    render(<StateSelect country="United States" value="" onChange={vi.fn()} />);

    // Placeholder trigger, not a text input.
    expect(screen.getByText("Select state")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("shows the selected full state name on the US trigger", () => {
    render(<StateSelect country="United States" value="California" onChange={vi.fn()} />);
    expect(screen.getByText("California")).toBeTruthy();
    expect(screen.queryByText("Select state")).toBeNull();
  });

  it("keeps an unrecognized legacy value visible rather than dropping it", () => {
    render(<StateSelect country="United States" value="Freedonia" onChange={vi.fn()} />);
    expect(screen.getByText("Freedonia")).toBeTruthy();
  });

  it("treats empty country as the US (forms default to United States)", () => {
    render(<StateSelect country="" value="" onChange={vi.fn()} />);
    expect(screen.getByText("Select state")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
