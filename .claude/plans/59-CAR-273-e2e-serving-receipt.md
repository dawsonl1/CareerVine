# CAR-273 — Prove the E2E server is the one SERVING, and stop concurrent runs corrupting each other

The arming receipt proves the stub layer armed **in a process**. It does not
prove that process is the one answering on `BASE_URL`. Observed 2026-08-07: a
second worktree's server armed (receipt written, correct worktree path in the
log line) and then failed to bind:

    [WebServer] ⨯ Failed to start server
    Error: listen EADDRINUSE: address already in use :::3100

`reuseExistingServer` had already seen the port busy, so Playwright proceeded,
`global-setup` found the receipt, and 21 tests ran against the OTHER worktree's
build. That is the same false-green class the receipt exists to close, relocated
from "denials never generated" to "receipt written by a process that never
served".

## Part 1 — the receipt must round-trip over HTTP

A file on disk can only ever prove something happened in *some* process. The
check has to interrogate **the thing answering the port**.

- `playwright.config.ts` mints one nonce per run:
  `process.env.E2E_ARMING_NONCE ??= randomUUID()`. Set on the Playwright main
  process so worker processes inherit the same value, and passed into
  `webServer.env` so the server gets it too.
- `register.mjs`, which is already loaded into the server process before Next
  touches a route module, patches `http.Server.prototype.emit` to answer
  `GET /__e2e__/arming` with `{ nonce, pid }` **from that process's own memory**.
- `global-setup.ts` fetches `${BASE_URL}/__e2e__/arming` and requires the nonce
  to equal this run's. A server from another run answers with a different nonce;
  a server with no stub layer 404s through to Next and answers nothing.

**Deliberately inside `register.mjs`, not a Next route.** A route under
`src/app/__e2e__/` would ship in the production bundle. `register.mjs` is loaded
only by `NODE_OPTIONS` in this tier, so the endpoint cannot exist anywhere else,
and patching `emit` intercepts before Next's handler ever sees the request.

The existing file-receipt check STAYS. It fires earlier and says something
different and more actionable ("no server in this run ever armed"), where the
nonce check says "the server on this port is not ours". Keeping both means each
failure gets the message that actually diagnoses it.

## Part 2 — concurrent worktrees fail fast

Two shared resources, and fixing only the first would be worse than useless
because it makes the second more likely to go unnoticed.

**The port.** `E2E_PORT` derives from a hash of the repo root, so two worktrees
do not collide by default. An explicit `E2E_PORT` still wins.

**The Supabase stack, which the port cannot fix.** All worktrees share one local
stack, and `tenant.teardown.ts` prefix-sweeps every `itest-e2e-*` tenant, so two
concurrent runs delete each other's tenants mid-flight *even on different ports*.
So a lock keyed on the stack's DB URL, held in `os.tmpdir()` (outside every
worktree). Acquired in `global-setup`, released in `global-teardown`.

- A live holder fails the run immediately, naming the holder's worktree and pid.
- A stale lock (holder pid dead) is stolen, with a line saying so, because a
  crashed run must not wedge the tier permanently.
- Acquired in `global-setup` rather than at config load: config is re-evaluated
  in every worker, which would have each worker fight the main process for its
  own lock. `global-setup` runs once, and it runs BEFORE `auth.setup.ts` creates
  a tenant, so nothing can be corrupted by the time it refuses.

The cost is that a refused run has already paid for `next build`. That is the
right trade against a silently corrupted run, and it is the ordering Playwright
gives us.

## Verification

- `npx playwright test` from `careervine/` — the tier must still pass end to end.
- **Deliberate reproduction of the original bug**: a stray `next start` on this
  worktree's derived port from a different checkout, then a run. It must REFUSE,
  citing the nonce mismatch, rather than proceeding. Before this change the same
  setup ran the suite against the stray server.
- **Deliberate reproduction of the lock**: hold the lock with a live pid and
  confirm a second run refuses and names the holder.
- Unit coverage for the pure pieces: port derivation is stable per path and
  differs across paths; lock acquire/steal/release including the dead-pid case.
- `src/__tests__/e2e-env-allowlist.test.ts` must still pass, since a new env var
  reaches the server.
