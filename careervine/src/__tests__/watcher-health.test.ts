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
  checkWatcherHealth,
  SEND_WATCHER,
  WATCHER_STALE_MINUTES,
  WATCHER_ALERT_COOLDOWN_HOURS,
} from "@/lib/watcher-health";

const NOW = "2026-08-03T12:00:00.000Z";
const minutesAgo = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();
const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();

function stubService(row: { last_seen_at: string; last_alerted_at: string | null } | null) {
  const updates: Array<Record<string, unknown>> = [];
  const upserts: Array<Record<string, unknown>> = [];
  const service = {
    from() {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: row, error: null }),
        update(values: Record<string, unknown>) {
          updates.push(values);
          return chain;
        },
        upsert(values: Record<string, unknown>) {
          upserts.push(values);
          return Promise.resolve({ error: null });
        },
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

describe("recordWatcherBeat", () => {
  it("upserts the watcher's last-seen stamp", async () => {
    const { service, upserts } = stubService(null);
    await recordWatcherBeat(service, NOW);
    expect(upserts).toEqual([{ name: SEND_WATCHER, last_seen_at: NOW }]);
  });

  it("swallows a write failure so a send is never lost to bookkeeping", async () => {
    const service = {
      from() {
        throw new Error("db down");
      },
    } as unknown as SupabaseClient;
    await expect(recordWatcherBeat(service, NOW)).resolves.toBeUndefined();
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

  it("stays quiet when the watcher has never run at all", async () => {
    // The state between this shipping and the box being provisioned. Alerting
    // here would just be day-one noise about a thing that was never up.
    const { service } = stubService(null);
    const health = await checkWatcherHealth(service, NOW);
    expect(health.stale).toBe(false);
    expect(notifyOwner).not.toHaveBeenCalled();
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

  it("suppresses the alert rather than crying wolf when the read fails", async () => {
    const service = {
      from() {
        throw new Error("db down");
      },
    } as unknown as SupabaseClient;
    const health = await checkWatcherHealth(service, NOW);
    expect(health.stale).toBe(false);
    expect(notifyOwner).not.toHaveBeenCalled();
  });
});
