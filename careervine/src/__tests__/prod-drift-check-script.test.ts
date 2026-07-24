// CAR-171: scripts/supabase-prod-drift-check.sh must fail fast and clearly
// when the shadow database port is held (a local `supabase start` stack),
// instead of retrying a deterministic conflict and blaming "prod connection /
// link / CLI issue". These tests run the real script with stub `docker` and
// `supabase` executables on a prepended PATH, so no Docker or Supabase link is
// needed. DRIFT_CHECK_SHADOW_PORT / DRIFT_CHECK_RETRY_DELAY are the script's
// documented test hooks.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:net";
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

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
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
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("failed to provision its shadow database");
    expect(res.stderr).toContain("supabase stop --project-id careervine");
    expect(res.stderr).not.toContain("prod connection / link / CLI issue");
    // The shadow failure itself must never consume a retry: every run beyond
    // the first must be accounted for by a (transient, non-shadow) retry line.
    expect(stubRuns()).toBe(retryLines(res.stderr) + 1);
  });

  it("keeps the 3-attempt retry and generic fail-closed message for other failures", async () => {
    rmSync(stubLog, { force: true });
    const port = await freePort();
    const res = runScript({
      DRIFT_CHECK_SHADOW_PORT: String(port),
      STUB_MODE: "fail",
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("could not check drift after 3 attempts (prod connection / link / CLI issue)");
    expect(res.stderr).toContain("must not read as 'no drift'");
    expect(stubRuns()).toBe(3);
  });
});
