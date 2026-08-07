import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import {
  acquireStackLock,
  releaseStackLock,
  lockPathFor,
} from "../../e2e/helpers/stack-lock";
import { __derivePortForTest } from "../../e2e/helpers/ports";

/**
 * CAR-273. Two worktrees running the E2E tier at once corrupted each other:
 * same port, and — the half a port cannot fix — the same local Supabase stack,
 * which `tenant.teardown.ts` sweeps by prefix.
 *
 * The lock is the part that has to be right under a race, so the cases here are
 * the ones where being wrong is silent: a dead holder wedging the tier forever,
 * and a live holder being ignored.
 */

const DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const OTHER_DB_URL = "postgresql://postgres:postgres@127.0.0.1:65432/postgres";

beforeEach(() => {
  fs.rmSync(lockPathFor(DB_URL), { force: true });
  fs.rmSync(lockPathFor(OTHER_DB_URL), { force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(lockPathFor(DB_URL), { force: true });
  fs.rmSync(lockPathFor(OTHER_DB_URL), { force: true });
});

describe("stack lock", () => {
  it("grants the lock when nothing holds it", () => {
    expect(acquireStackLock(DB_URL, "/repo/a").ok).toBe(true);
    expect(fs.existsSync(lockPathFor(DB_URL))).toBe(true);
  });

  it("refuses a second run and names the live holder", () => {
    acquireStackLock(DB_URL, "/repo/a");

    // A different, LIVE pid: this process is alive by definition, so writing
    // the holder as someone else's pid would be a lie the `alive` check sees
    // through. Point it at pid 1, which always exists.
    fs.writeFileSync(
      lockPathFor(DB_URL),
      JSON.stringify({ pid: 1, root: "/repo/other", startedAt: "2026-08-07T00:00:00.000Z" }),
    );

    const result = acquireStackLock(DB_URL, "/repo/b");
    expect(result.ok).toBe(false);
    expect(result.heldBy?.root).toBe("/repo/other");
    expect(result.heldBy?.pid).toBe(1);
  });

  it("takes over a lock whose holder is dead, so a crash cannot wedge the tier", () => {
    // A pid that cannot be running. Guarded rather than assumed: if it somehow
    // is alive, this test would assert the opposite of what it means to.
    const DEAD = 2 ** 22;
    let deadIsAlive = true;
    try {
      process.kill(DEAD, 0);
    } catch {
      deadIsAlive = false;
    }
    expect(deadIsAlive, "pid chosen as dead is actually running").toBe(false);

    fs.writeFileSync(
      lockPathFor(DB_URL),
      JSON.stringify({ pid: DEAD, root: "/repo/crashed", startedAt: "2026-08-07T00:00:00.000Z" }),
    );

    const result = acquireStackLock(DB_URL, "/repo/b");
    expect(result.ok).toBe(true);
    expect(result.stolenFrom?.root).toBe("/repo/crashed");
  });

  it("takes over a corrupt lock file rather than deadlocking on it", () => {
    fs.writeFileSync(lockPathFor(DB_URL), "{not json");
    expect(acquireStackLock(DB_URL, "/repo/b").ok).toBe(true);
  });

  it("locks per STACK, so two checkouts on different stacks both run", () => {
    expect(acquireStackLock(DB_URL, "/repo/a").ok).toBe(true);
    expect(acquireStackLock(OTHER_DB_URL, "/repo/b").ok).toBe(true);
  });

  it("releases only its own lock", () => {
    acquireStackLock(DB_URL, "/repo/a");
    releaseStackLock(DB_URL);
    expect(fs.existsSync(lockPathFor(DB_URL))).toBe(false);
  });

  it("never yanks a lock that now belongs to someone else", () => {
    // The sequence that makes this matter: we crash, a later run steals the
    // lock, and our teardown finally fires. It must not delete theirs.
    fs.writeFileSync(
      lockPathFor(DB_URL),
      JSON.stringify({ pid: 1, root: "/repo/other", startedAt: "2026-08-07T00:00:00.000Z" }),
    );
    releaseStackLock(DB_URL);
    expect(fs.existsSync(lockPathFor(DB_URL))).toBe(true);
  });
});

describe("derived E2E port", () => {
  it("is stable for one checkout", () => {
    expect(__derivePortForTest("/repo/a")).toBe(__derivePortForTest("/repo/a"));
  });

  it("differs across worktrees, which is the collision CAR-273 removed", () => {
    // Realistic sibling paths, not arbitrary strings: the derivation has to
    // separate names that share a long prefix.
    const a = __derivePortForTest("/Users/d/Projects/app/.claude/worktrees/CAR-268-company-cache");
    const b = __derivePortForTest("/Users/d/Projects/app/.claude/worktrees/CAR-273-e2e-receipt");
    expect(a).not.toBe(b);
  });

  it("stays inside the intended range", () => {
    for (const p of ["/a", "/b", "/c/d/e", "/repo/worktrees/x", "/repo/worktrees/y"]) {
      const port = __derivePortForTest(p);
      expect(port).toBeGreaterThanOrEqual(3100);
      expect(port).toBeLessThanOrEqual(3199);
    }
  });
});
