"use client";

import { useEffect, useCallback, useSyncExternalStore } from "react";
import { useAuth } from "@/components/auth-provider";
import { apiFetch } from "@/lib/api-client";

/**
 * Connection data returned by /api/gmail/connection.
 * Shared across all components that need calendar/gmail status.
 */
export type GmailConnectionData = {
  send_scope_granted: boolean;
  calendar_scopes_granted: boolean;
  calendar_last_synced_at: string | null;
  availability_standard: unknown;
  availability_priority: unknown;
  calendar_list: Array<{ id: string; summary: string; accessRole: string }>;
  busy_calendar_ids: string[];
  calendar_timezone: string;
};

// ── Module-level store ──────────────────────────────────────────────────
// All hook instances subscribe to the same store so refresh() notifies everyone.

type StoreState = {
  data: GmailConnectionData | null;
  loading: boolean;
};

let state: StoreState = { data: null, loading: true };
let fetchPromise: Promise<GmailConnectionData | null> | null = null;
const listeners = new Set<() => void>();

// Monotonic request id: the store's `useLatestRequest` equivalent (CAR-190).
// `fetchPromise` alone does not order anything, because refresh() and
// invalidateGmailConnectionCache() both null it *before* the request they
// supersede has resolved — so two responses can be live against one store with
// nothing to say which is newer. The onboarding poll refreshes every 3s, and a
// stale `connection: null` landing after a connected one flipped the whole app
// back to "Connect Gmail" for a poll interval.
let requestSeq = 0;

// The newest sequence that has WRITTEN. Ordering is decided on arrival, not on
// issue, and getting that distinction wrong starves the store: a first version
// gated on `seq === requestSeq` ("only the newest request I have issued may
// write"), which under a fixed-interval poll means a response commits only if
// it beats the interval. Every request is issued by a tick, so any latency
// above 3s left every response superseded in flight, nothing ever wrote, and
// the onboarding banner sat on "Connect Gmail" forever — the exact opposite of
// what the poll exists to do. `useLatestRequest`, which this mirrors, drops a
// response older than what is already committed; it does not require the
// committer to still be the newest in flight.
let committedSeq = 0;

function getSnapshot(): StoreState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setState(patch: Partial<StoreState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function fetchConnection(): Promise<GmailConnectionData | null> {
  if (fetchPromise) return fetchPromise;
  const seq = ++requestSeq;
  const pending: Promise<GmailConnectionData | null> = apiFetch<{
    connection?: GmailConnectionData | null;
  }>("/api/gmail/connection")
    .then((data) => {
      const conn = data.connection || null;
      // A response older than what is already committed still resolves its own
      // callers, it just does not write the shared store.
      if (seq > committedSeq) {
        committedSeq = seq;
        setState({ data: conn, loading: false });
      }
      return conn;
    })
    .catch(() => {
      // Keep whatever data we already have — a failed background refresh
      // must not make connected integrations flash as disconnected.
      if (seq > committedSeq) {
        committedSeq = seq;
        setState({ loading: false });
      }
      return null;
    })
    .finally(() => {
      // Only clear the dedupe handle if it still points at THIS request;
      // a stale one clearing it would let a third caller start a third fetch
      // while the newest is still in flight.
      if (fetchPromise === pending) fetchPromise = null;
    });
  fetchPromise = pending;
  return pending;
}

// SSR-safe snapshot (always loading, no data)
const serverSnapshot: StoreState = { data: null, loading: true };
function getServerSnapshot(): StoreState {
  return serverSnapshot;
}

/**
 * Shared hook for /api/gmail/connection data.
 * All instances share one store — refresh() from any component updates all of them.
 */
export function useGmailConnection() {
  const { user } = useAuth();
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Trigger initial fetch when user is available
  useEffect(() => {
    if (!user) return;
    if (snap.data !== null || fetchPromise) return; // already have data or in-flight
    // Fire-and-forget: fetchConnection catches its own errors and keeps prior data.
    void fetchConnection();
  }, [user, snap.data]);

  // Silent background refresh: consumers keep rendering current data until
  // the new snapshot lands. `loading` means "initial load, no data yet" —
  // flipping it here made every consumer that hides on `loading` (e.g. the
  // setup banner) blink on each onboarding poll.
  const refresh = useCallback(async () => {
    fetchPromise = null;
    await fetchConnection();
  }, []);

  return {
    data: snap.data,
    loading: snap.loading,
    refresh,
    calendarConnected: snap.data?.calendar_scopes_granted || false,
    calendarLastSynced: snap.data?.calendar_last_synced_at || null,
  };
}

/**
 * Reset the cache (call after disconnect operations).
 *
 * Must be followed by a refresh: this deliberately starts no request of its
 * own, so an already-mounted consumer whose `data` was already null sees no
 * dependency change and never re-runs its mount effect. Every call site pairs
 * it with `void refresh()`.
 */
export function invalidateGmailConnectionCache() {
  // Retire every sequence issued so far, so a request still in flight cannot
  // write the store after this point. Without it, a disconnect that races an
  // in-flight refresh is undone by that refresh's stale "still connected"
  // response.
  committedSeq = requestSeq;
  fetchPromise = null;
  setState({ data: null, loading: true });
}
