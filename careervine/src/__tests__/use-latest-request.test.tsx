// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { useState } from "react";
import { useLatestRequest } from "@/hooks/use-latest-request";

/**
 * CAR-145 / F19: out-of-order async results must not let a stale response
 * overwrite a newer one. This test issues request A then request B, resolves B
 * first, then resolves A last — the guard must keep B's result. If the guard
 * were removed, A resolving last would clobber the value and this test fails.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function Harness({ a, b }: { a: Promise<string>; b: Promise<string> }) {
  const req = useLatestRequest();
  const [value, setValue] = useState("initial");
  const start = async (p: Promise<string>) => {
    const token = req.begin();
    const result = await p;
    if (!req.isLatest(token)) return;
    setValue(result);
  };
  return (
    <div>
      <span data-testid="value">{value}</span>
      <button onClick={() => start(a)}>A</button>
      <button onClick={() => start(b)}>B</button>
    </div>
  );
}

describe("useLatestRequest", () => {
  afterEach(() => cleanup());

  it("keeps the newest request's result even when an older one resolves last", async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    render(<Harness a={a.promise} b={b.promise} />);

    // Issue A, then B (B is now the latest request).
    fireEvent.click(screen.getByText("A"));
    fireEvent.click(screen.getByText("B"));

    // B resolves first and wins.
    await act(async () => {
      b.resolve("B-result");
    });
    expect(screen.getByTestId("value").textContent).toBe("B-result");

    // A resolves last but is stale, so it must be ignored.
    await act(async () => {
      a.resolve("A-result");
    });
    expect(screen.getByTestId("value").textContent).toBe("B-result");
  });
});
