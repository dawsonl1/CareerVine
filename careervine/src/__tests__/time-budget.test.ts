import { describe, it, expect, vi } from "vitest";
import { runWithResponseDeadline } from "@/lib/time-budget";

describe("runWithResponseDeadline", () => {
  it("returns the work result when work resolves before the deadline", async () => {
    const onDeadline = vi.fn(async () => "backstop");
    const result = await runWithResponseDeadline(1000, Promise.resolve("done"), onDeadline);
    expect(result).toBe("done");
    expect(onDeadline).not.toHaveBeenCalled();
  });

  it("runs onDeadline when the deadline fires before work", async () => {
    const slow = new Promise<string>((r) => setTimeout(() => r("slow"), 50));
    const result = await runWithResponseDeadline(0, slow, () => "backstop");
    expect(result).toBe("backstop");
  });

  it("awaits an async onDeadline", async () => {
    // work never settles — only the backstop can complete this.
    const result = await runWithResponseDeadline(0, new Promise<number>(() => {}), async () => {
      await Promise.resolve();
      return 42;
    });
    expect(result).toBe(42);
  });

  it("clears its timer when work wins (no leak / no dangling event loop)", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    await runWithResponseDeadline(10_000, Promise.resolve("x"), () => "y");
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it("treats a negative/zero budget as an immediate deadline", async () => {
    const result = await runWithResponseDeadline(-5, new Promise<string>(() => {}), () => "backstop");
    expect(result).toBe("backstop");
  });
});
