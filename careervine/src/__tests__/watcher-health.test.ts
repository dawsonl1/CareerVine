/**
 * CAR-215: the two send drivers watching each other.
 *
 * The failure this guards against is not "email stops". It is "email quietly
 * gets an hour later and nobody notices", which is what a dead A1 watcher looks
 * like from the outside while the hourly QStash net keeps delivering.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const notifyOwner = vi.fn(async (_subject: string, _text: string) => true);
vi.mock("@/lib/admin-notify", () => ({
  notifyOwner: (subject: string, text: string) => notifyOwner(subject, text),
}));

import {
  recordWatcherBeat,
  recordDriverBeat,
  checkWatcherHealth,
  SEND_WATCHER,
  QSTASH_SAFETY_NET,
  WATCHER_STALE_MINUTES,
  WATCHER_ALERT_COOLDOWN_HOURS,
} from "@/lib/watcher-health";

const NOW = "2026-08-03T12:00:00.000Z";
const minutesAgo = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();
const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();

/**
 * `readError` / `writeError` are RETURNED, never thrown — that is how
 * supabase-js surfaces a PostgREST refusal (shouldThrowOnError defaults false),
 * and it is the shape the production failures actually take. A stub that can
 * only throw exercises the transport path alone (CAR-220).
 */
function stubService(
  row: { last_seen_at: string; last_alerted_at: string | null } | null,
  opts: { readError?: { message: string }; writeError?: { message: string } } = {},
) {
  const updates: Array<Record<string, unknown>> = [];
  const upserts: Array<Record<string, unknown>> = [];
  const service = {
    from() {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () =>
          opts.readError ? { data: null, error: opts.readError } : { data: row, error: null },
        update(values: Record<string, unknown>) {
          updates.push(values);
          return chain;
        },
        upsert(values: Record<string, unknown>) {
          upserts.push(values);
          return Promise.resolve({ error: opts.writeError ?? null });
        },
        // The update chain is awaited directly (no .single()), so it has to be
        // thenable to hand back a returned error like the real builder does.
        then: (resolve: (v: unknown) => void) => resolve({ error: opts.writeError ?? null }),
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  return { service, updates, upserts };
}

beforeEach(() => {
  notifyOwner.mockClear();
  notifyOwner.mockResolvedValue(true);
});

describe("recordDriverBeat", () => {
  it("upserts the watcher's last-seen stamp", async () => {
    const { service, upserts } = stubService(null);
    await recordWatcherBeat(service, NOW);
    expect(upserts).toEqual([{ name: SEND_WATCHER, last_seen_at: NOW }]);
  });

  it("stamps the QStash safety net under its own row key", async () => {
    // The table's PK is `name` precisely so more than one driver can report.
    // Stamping it is what makes "which driver last ran" answerable at all; the
    // watcher-side reader that would arm an alarm on it is not built yet.
    const { service, upserts } = stubService(null);
    await recordDriverBeat(service, QSTASH_SAFETY_NET, NOW);
    expect(upserts).toEqual([{ name: QSTASH_SAFETY_NET, last_seen_at: NOW }]);
    expect(QSTASH_SAFETY_NET).not.toBe(SEND_WATCHER);
  });

  it("swallows a THROWN write failure so a send is never lost to bookkeeping", async () => {
    const service = {
      from() {
        throw new Error("db down");
      },
    } as unknown as SupabaseClient;
    await expect(recordWatcherBeat(service, NOW)).resolves.toBeUndefined();
  });

  it("logs a RETURNED write error — the shape PostgREST actually produces", async () => {
    // The path that matters in production and had no coverage: supabase-js
    // returns a refused write in `{ error }` and never throws, so the try/catch
    // saw nothing and a silently-failing upsert left no row at all. A missing
    // row reads as "not provisioned yet" in checkWatcherHealth, so the alarm
    // can never arm — with this log as the only trace that anything is wrong.
    const { service } = stubService(null, {
      writeError: { message: "permission denied for table cron_heartbeats" },
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(recordWatcherBeat(service, NOW)).resolves.toBeUndefined();
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("[watcher-health]"),
        expect.stringContaining("permission denied"),
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("checkWatcherHealth", () => {
  it("stays quiet when the watcher reported recently", async () => {
    const { service } = stubService({ last_seen_at: minutesAgo(5), last_alerted_at: null });
    const health = await checkWatcherHealth(service, NOW);
    expect(health.stale).toBe(false);
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("stays quiet right up to the staleness threshold", async () => {
    const { service } = stubService({
      last_seen_at: minutesAgo(WATCHER_STALE_MINUTES - 1),
      last_alerted_at: null,
    });
    expect((await checkWatcherHealth(service, NOW)).stale).toBe(false);
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("emails once the watcher has gone quiet past the threshold", async () => {
    const { service, updates } = stubService({
      last_seen_at: minutesAgo(WATCHER_STALE_MINUTES + 5),
      last_alerted_at: null,
    });
    const health = await checkWatcherHealth(service, NOW);

    expect(health.stale).toBe(true);
    expect(health.alerted).toBe(true);
    expect(notifyOwner).toHaveBeenCalledTimes(1);

    const [subject, body] = notifyOwner.mock.calls[0] as unknown as [string, string];
    expect(subject).toContain("send watcher");
    // The email has to say the thing that stops a 2am panic: mail is still going.
    expect(body).toContain("Email is still going out");
    expect(body).toContain("ssh a1");
    // And it must record that it alerted, or it repeats every hour.
    expect(updates).toEqual([{ last_alerted_at: NOW }]);
  });

  it("does not re-email inside the cooldown while the box stays down", async () => {
    const { service } = stubService({
      last_seen_at: hoursAgo(30),
      last_alerted_at: hoursAgo(WATCHER_ALERT_COOLDOWN_HOURS - 1),
    });
    const health = await checkWatcherHealth(service, NOW);
    expect(health.stale).toBe(true);
    expect(health.alerted).toBe(false);
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("re-emails once the cooldown has elapsed", async () => {
    const { service } = stubService({
      last_seen_at: hoursAgo(30),
      last_alerted_at: hoursAgo(WATCHER_ALERT_COOLDOWN_HOURS + 1),
    });
    expect((await checkWatcherHealth(service, NOW)).alerted).toBe(true);
    expect(notifyOwner).toHaveBeenCalledTimes(1);
  });

  it("re-anchors and logs a MISSING row instead of accepting it as a healthy state", async () => {
    // A missing row used to be the normal pre-provisioning state, and returning
    // idle for it was right. CAR-220's migration seeds `send-watcher` at now(),
    // so it is now an anomaly: the migration did not run, or something deleted
    // the row. Either way the row is the alarm's only anchor, and with no anchor
    // the alarm can never arm no matter how long the watcher stays dead.
    //
    // It still must not ALERT: a missing row says nothing about the watcher, and
    // "the watcher has gone quiet" would be a claim we cannot make. Re-anchoring
    // costs one write and puts the alarm back within one staleness window.
    const { service, upserts } = stubService(null);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const health = await checkWatcherHealth(service, NOW);

      expect(health.stale).toBe(false);
      expect(notifyOwner).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("missing"));
      expect(upserts).toEqual([{ name: SEND_WATCHER, last_seen_at: NOW }]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not stamp last_alerted_at when the email failed to send", async () => {
    // Otherwise a transient Resend failure silently buys 12 hours of silence.
    notifyOwner.mockResolvedValue(false);
    const { service, updates } = stubService({
      last_seen_at: hoursAgo(5),
      last_alerted_at: null,
    });
    const health = await checkWatcherHealth(service, NOW);
    expect(health.stale).toBe(true);
    expect(health.alerted).toBe(false);
    expect(updates).toEqual([]);
  });

  it("suppresses the alert rather than crying wolf when the read THROWS", async () => {
    const service = {
      from() {
        throw new Error("db down");
      },
    } as unknown as SupabaseClient;
    const health = await checkWatcherHealth(service, NOW);
    expect(health.stale).toBe(false);
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("logs when the staleness read RETURNS an error instead of reading it as 'never provisioned'", async () => {
    // A refused read comes back as { data: null, error }, which is byte-for-byte
    // indistinguishable from "no row yet" once `error` is dropped — so a broken
    // read silently took the no-row branch and returned a healthy verdict. The
    // suppression is still correct (a read that failed proves nothing about the
    // watcher); the silence was not.
    const { service } = stubService(null, {
      readError: { message: "canceling statement due to statement timeout" },
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const health = await checkWatcherHealth(service, NOW);
      expect(health.stale).toBe(false);
      expect(notifyOwner).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("[watcher-health]"),
        expect.stringContaining("statement timeout"),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("logs a RETURNED error on the alert stamp rather than losing it silently", async () => {
    // Same PostgREST shape as the beat upsert. Losing this stamp costs a repeat
    // email every hour for as long as the box stays down, which is worth
    // knowing about from the logs rather than from the inbox.
    const { service } = stubService(
      { last_seen_at: hoursAgo(5), last_alerted_at: null },
      { writeError: { message: "deadlock detected" } },
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const health = await checkWatcherHealth(service, NOW);
      expect(health.alerted).toBe(true);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("[watcher-health]"),
        expect.stringContaining("deadlock detected"),
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
