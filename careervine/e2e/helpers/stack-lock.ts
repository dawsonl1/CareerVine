/**
 * One E2E run at a time per local Supabase stack (CAR-273).
 *
 * Deriving a per-worktree port (`ports.ts`) stops two runs fighting over the
 * HTTP port, and stops there. The database is the resource that actually
 * corrupts: every worktree points at the SAME local stack, and
 * `e2e/tenant.teardown.ts` deletes by PREFIX — every `itest-e2e-*` tenant, not
 * just the one this run made. So two concurrent runs delete each other's
 * tenants mid-flight however their servers are addressed, and the failures land
 * on whichever run happened to still be using the row.
 *
 * That is a corruption this tier cannot detect from the inside: a tenant
 * vanishing mid-run looks exactly like a bug in the code under test. Refusing to
 * start is the only honest option, so this is a hard lock rather than a queue.
 *
 * Keyed on the STACK, not the worktree, because the stack is what is shared. Two
 * checkouts pointed at different Supabase instances may run concurrently and
 * this will let them.
 *
 * Lives in `os.tmpdir()`, outside every checkout, for the same reason.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface LockHolder {
  pid: number;
  /** The checkout that holds it, so the message names something actionable. */
  root: string;
  startedAt: string;
}

export function lockPathFor(dbUrl: string): string {
  const key = crypto.createHash("sha256").update(dbUrl).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `careervine-e2e-stack-${key}.lock`);
}

/** Is a pid still running? `signal 0` tests for existence without delivering. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to someone else, which still counts.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readHolder(file: string): LockHolder | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as LockHolder).pid === "number"
    ) {
      return parsed as LockHolder;
    }
    // Unreadable shape: treat as stale rather than wedging the tier forever.
    return null;
  } catch {
    return null;
  }
}

export interface AcquireResult {
  ok: boolean;
  /** Set when `ok` is false — the live run holding the stack. */
  heldBy?: LockHolder;
  /** Set when a dead holder's lock was taken over, so the caller can say so. */
  stolenFrom?: LockHolder;
}

/**
 * Take the lock, or report who has it.
 *
 * `wx` is the whole mechanism: an atomic create-or-fail, so two runs racing here
 * cannot both believe they won. Everything else is about the loser deciding
 * whether the winner is actually alive.
 */
export function acquireStackLock(
  dbUrl: string,
  root: string,
  now: () => Date = () => new Date(),
): AcquireResult {
  const file = lockPathFor(dbUrl);
  const mine: LockHolder = { pid: process.pid, root, startedAt: now().toISOString() };

  const write = () => fs.writeFileSync(file, JSON.stringify(mine, null, 2), { flag: "wx" });

  try {
    write();
    return { ok: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  const holder = readHolder(file);
  // A crashed run must not wedge the tier permanently, so a dead holder loses
  // its claim. A missing/corrupt file counts as dead for the same reason.
  if (holder && alive(holder.pid)) return { ok: false, heldBy: holder };

  fs.rmSync(file, { force: true });
  try {
    write();
  } catch (err) {
    // Someone else stole it in the same instant. They are alive by definition.
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return { ok: false, heldBy: readHolder(file) ?? undefined };
    }
    throw err;
  }
  return { ok: true, stolenFrom: holder ?? undefined };
}

/** Release only if we still hold it, so a stolen lock is never yanked from its new owner. */
export function releaseStackLock(dbUrl: string): void {
  const file = lockPathFor(dbUrl);
  const holder = readHolder(file);
  if (holder && holder.pid !== process.pid) return;
  fs.rmSync(file, { force: true });
}
