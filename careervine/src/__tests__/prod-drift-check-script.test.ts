// CAR-171: scripts/supabase-prod-drift-check.sh must fail fast and clearly
// when the shadow database port is held (a local `supabase start` stack),
// instead of retrying a deterministic conflict and blaming "prod connection /
// link / CLI issue". These tests run the real script with stub `docker` and
// `supabase` executables on a prepended PATH, so no Docker or Supabase link is
// needed. DRIFT_CHECK_SHADOW_PORT / DRIFT_CHECK_RETRY_DELAY are the script's
// documented test hooks.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { connect, createServer, type Server } from "node:net";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../../..");
const script = path.join(repoRoot, "scripts", "supabase-prod-drift-check.sh");

let binDir: string;
let stubLog: string;

function writeStub(name: string, body: string) {
  const p = path.join(binDir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
}

function runScript(env: Record<string, string>) {
  return spawnSync("bash", [script], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      STUB_LOG: stubLog,
      DRIFT_CHECK_RETRY_DELAY: "0",
      ...env,
    },
  });
}

function stubRuns(): number {
  if (!existsSync(stubLog)) return 0;
  return readFileSync(stubLog, "utf8").split("\n").filter(Boolean).length;
}

/**
 * A port nothing is listening on, for the three cases that need the script's
 * shadow-port pre-check to PASS (CAR-212).
 *
 * This used to be `listen(0)` — bind an ephemeral port, read the number, close
 * the listener, return the number. That is a use-after-release: the number is
 * handed back with nothing holding it, and the script then probes it from a
 * freshly spawned bash some milliseconds later.
 *
 * Measured, on this machine: every such port is inside the OS ephemeral range
 * (49152-65535 on darwin, 32768-60999 on typical Linux), every one is
 * immediately re-bindable, and the allocator reissues that exact number after
 * ~16,375 further allocations — the size of the range, because allocation
 * marches sequentially and wraps. A full suite run makes tens of thousands of
 * ephemeral allocations, so it wraps repeatedly, and each wrap is a chance to
 * hand one of these numbers to another process that then HOLDS it. The script's
 * pre-check sees a live listener, exits 1 with "port ... is already in use",
 * never invokes the stub, and all three cases fail on assertions about a branch
 * that never ran. Observed once in ~13 full-suite runs before it was diagnosed.
 *
 * The fix is to draw from BELOW both platforms' ephemeral floors, so ambient
 * allocation structurally cannot hand this number to anyone, and then to verify
 * the candidate with the same question the script asks (does anything ACCEPT a
 * connection here?) rather than assuming. The scan starts at an offset derived
 * from the pid so two concurrent suite runs on one machine do not converge on
 * the same candidate.
 */
const CANDIDATE_LO = 20_000;
const CANDIDATE_HI = 32_000; // below Linux's 32768 ephemeral floor

/** The script's own question: does anything accept a connection on this port? */
function nothingListeningOn(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host: "127.0.0.1" });
    const done = (free: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(free);
    };
    sock.once("connect", () => done(false));
    sock.once("error", () => done(true));
    sock.setTimeout(500, () => done(true));
  });
}

async function freePort(): Promise<number> {
  const span = CANDIDATE_HI - CANDIDATE_LO;
  const start = process.pid % span;
  for (let i = 0; i < span; i++) {
    const port = CANDIDATE_LO + ((start + i) % span);
    if (await nothingListeningOn(port)) return port;
  }
  throw new Error(
    `No free port in ${CANDIDATE_LO}-${CANDIDATE_HI} for the drift-check shadow-port stub.`,
  );
}

function listenOn(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ server, port });
    });
    server.on("error", reject);
  });
}

beforeAll(() => {
  binDir = mkdtempSync(path.join(tmpdir(), "drift-check-stubs-"));
  stubLog = path.join(binDir, "supabase-invocations.log");
  writeStub("docker", `exit 0`);
  writeStub(
    "supabase",
    `echo run >> "$STUB_LOG"
case "$STUB_MODE" in
  clean)
    printf '%s' '{"diff":"","dropStatements":[]}'
    ;;
  shadow)
    printf '%s' '{"_tag":"Error","error":{"code":"LegacyDeclarativeShadowDbError","message":"failed to provision the shadow database: exit 1"}}'
    echo 'failed to provision the shadow database: exit 1' >&2
    exit 1
    ;;
  fail)
    echo 'connection refused' >&2
    exit 1
    ;;
esac`,
  );
});

beforeAll(() => {
  // Warm-up: exec each freshly written stub once so a transient first-exec
  // failure (observed once on a cold run right after npm ci) can't leak a
  // spurious retry into the invocation-count assertions below.
  spawnSync(path.join(binDir, "docker"), { env: { ...process.env, STUB_LOG: stubLog } });
  spawnSync(path.join(binDir, "supabase"), { env: { ...process.env, STUB_LOG: stubLog, STUB_MODE: "clean" } });
  rmSync(stubLog, { force: true });
});

afterAll(() => {
  rmSync(binDir, { recursive: true, force: true });
});

/**
 * Fail with the real cause when the script bailed on its shadow-port pre-check
 * in a case that needed that port free (CAR-212). Without this, a collision
 * surfaces as "expected 1 to be +0" or a `toContain` about a branch the script
 * never reached, which is what made the original flake take a review to
 * diagnose rather than a glance at the failure.
 */
function assertPreCheckPassed(res: { stderr: string }, port: number) {
  if (res.stderr.includes(`shadow database port ${port} is already in use`)) {
    throw new Error(
      `Harness precondition violated: port ${port} was taken between selection and the script's probe, ` +
        `so the shadow-port pre-check short-circuited and the assertions below never got their branch. ` +
        `This should be impossible now that ports come from ${CANDIDATE_LO}-${CANDIDATE_HI}, below every ` +
        `platform's ephemeral floor — if you see it, something is deliberately binding that range.`,
    );
  }
}

// Count of "retrying..." lines the script printed; used to assert that a given
// failure mode did or did not consume retry attempts.
function retryLines(stderr: string): number {
  return (stderr.match(/db diff failed \(exit \d+\), retrying/g) ?? []).length;
}

describe("supabase-prod-drift-check.sh shadow-port handling (CAR-171)", () => {
  it("fails immediately with an actionable message when the shadow port is occupied, without invoking supabase", async () => {
    rmSync(stubLog, { force: true });
    const { server, port } = await listenOn();
    try {
      const res = runScript({
        DRIFT_CHECK_SHADOW_PORT: String(port),
        STUB_MODE: "clean",
      });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(`shadow database port ${port} is already in use`);
      expect(res.stderr).toContain("supabase stop --project-id careervine");
      expect(res.stderr).not.toContain("prod connection / link / CLI issue");
      expect(stubRuns()).toBe(0);
    } finally {
      server.close();
    }
  });

  it("exits 0 on a clean diff when the shadow port is free", async () => {
    rmSync(stubLog, { force: true });
    const port = await freePort();
    const res = runScript({
      DRIFT_CHECK_SHADOW_PORT: String(port),
      STUB_MODE: "clean",
    });
    assertPreCheckPassed(res, port);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("No production schema drift");
    expect(stubRuns()).toBe(1);
  });

  it("does not retry a mid-run shadow-provisioning failure and names the real cause", async () => {
    rmSync(stubLog, { force: true });
    const port = await freePort();
    const res = runScript({
      DRIFT_CHECK_SHADOW_PORT: String(port),
      STUB_MODE: "shadow",
    });
    assertPreCheckPassed(res, port);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("failed to provision its shadow database");
    expect(res.stderr).toContain("supabase stop --project-id careervine");
    expect(res.stderr).not.toContain("prod connection / link / CLI issue");
    // The shadow failure itself must never consume a retry: every run beyond
    // the first must be accounted for by a (transient, non-shadow) retry line.
    expect(stubRuns()).toBe(retryLines(res.stderr) + 1);
  });

  /**
   * The regression guard (CAR-212). The defect was not that the old allocator
   * was wrong-looking — `listen(0)` then close is a common idiom — it was that
   * the number it produced was drawn from the pool the OS reassigns from. A
   * future edit back to that idiom would reintroduce a ~1-in-13 flake that
   * nothing else in the suite can see, so the property is pinned directly.
   */
  it("draws shadow ports from outside the OS ephemeral range, so nothing can be handed the same number", async () => {
    const [lo, hi] =
      process.platform === "linux"
        ? readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/).map(Number)
        : [
            Number(spawnSync("sysctl", ["-n", "net.inet.ip.portrange.first"], { encoding: "utf8" }).stdout),
            Number(spawnSync("sysctl", ["-n", "net.inet.ip.portrange.last"], { encoding: "utf8" }).stdout),
          ];
    expect(Number.isFinite(lo) && Number.isFinite(hi) && lo > 0).toBe(true);

    // The candidate window must sit entirely below the pool, on this platform
    // and on the other one (Linux floors at 32768, darwin at 49152).
    expect(CANDIDATE_HI).toBeLessThanOrEqual(Math.min(lo, 32_768));

    const port = await freePort();
    expect(port).toBeGreaterThanOrEqual(CANDIDATE_LO);
    expect(port).toBeLessThan(CANDIDATE_HI);
    expect(port < lo || port > hi).toBe(true);
  });

  it("keeps the 3-attempt retry and generic fail-closed message for other failures", async () => {
    rmSync(stubLog, { force: true });
    const port = await freePort();
    const res = runScript({
      DRIFT_CHECK_SHADOW_PORT: String(port),
      STUB_MODE: "fail",
    });
    assertPreCheckPassed(res, port);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("could not check drift after 3 attempts (prod connection / link / CLI issue)");
    expect(res.stderr).toContain("must not read as 'no drift'");
    expect(stubRuns()).toBe(3);
  });
});
