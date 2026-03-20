"use client";

import { useState, useEffect, useCallback, useSyncExternalStore } from "react";
import { useAuth } from "@/components/auth-provider";

/**
 * Connection data returned by /api/gmail/connection.
 * Shared across all components that need calendar/gmail status.
 */
export type GmailConnectionData = {
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

function getSnapshot(): StoreState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  // Create new reference so useSyncExternalStore detects the change
  state = { ...state };
  listeners.forEach((l) => l());
}

function setState(patch: Partial<StoreState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function fetchConnection(): Promise<GmailConnectionData | null> {
  if (fetchPromise) return fetchPromise;
  fetchPromise = fetch("/api/gmail/connection")
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((data) => {
      const conn = data.connection || null;
      setState({ data: conn, loading: false });
      fetchPromise = null;
      return conn;
    })
    .catch(() => {
      setState({ data: null, loading: false });
      fetchPromise = null;
      return null;
    });
  return fetchPromise;
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
    fetchConnection();
  }, [user, snap.data]);

  const refresh = useCallback(async () => {
    fetchPromise = null;
    setState({ loading: true });
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

/** Reset the cache (call after disconnect operations) */
export function invalidateGmailConnectionCache() {
  fetchPromise = null;
  setState({ data: null, loading: true });
}
