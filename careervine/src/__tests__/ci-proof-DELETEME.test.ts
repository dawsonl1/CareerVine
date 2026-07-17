import { describe, it, expect } from "vitest";

// THROWAWAY: proves the CI gate fails a PR with a failing test. Delete with the branch.
describe("CI gate proof", () => {
  it("intentionally fails to prove red CI blocks merge", () => {
    expect(1).toBe(2);
  });
});
