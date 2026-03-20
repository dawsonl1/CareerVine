"use client";

import { useState, useEffect, useCallback, useRef } from "react";
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

// Module-level cache so multiple hook instances share one fetch per session
let cachedData: GmailConnectionData | null = null;
let fetchPromise: Promise<GmailConnectionData | null> | null = null;

function fetchConnection(): Promise<GmailConnectionData | null> {
  if (fetchPromise) return fetchPromise;
  fetchPromise = fetch("/api/gmail/connection")
    .then((res) => res.json())
    .then((data) => {
      const conn = data.connection || null;
      cachedData = conn;
      fetchPromise = null;
      return conn;
    })
    .catch(() => {
      fetchPromise = null;
      return null;
    });
  return fetchPromise;
}

/**
 * Shared hook for /api/gmail/connection data.
 * Deduplicates fetches: all components mounting simultaneously share one request.
 * Returns cached data on subsequent mounts within the same page session.
 */
export function useGmailConnection() {
  const { user } = useAuth();
  const [data, setData] = useState<GmailConnectionData | null>(cachedData);
  const [loading, setLoading] = useState(!cachedData);

  const refresh = useCallback(async () => {
    // Invalidate cache and refetch
    cachedData = null;
    fetchPromise = null;
    setLoading(true);
    const result = await fetchConnection();
    setData(result);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!user) return;
    if (cachedData) {
      setData(cachedData);
      setLoading(false);
      return;
    }
    let cancelled = false;
    fetchConnection().then((result) => {
      if (!cancelled) {
        setData(result);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [user]);

  return {
    data,
    loading,
    refresh,
    calendarConnected: data?.calendar_scopes_granted || false,
    calendarLastSynced: data?.calendar_last_synced_at || null,
  };
}

/** Reset the cache (call after disconnect operations) */
export function invalidateGmailConnectionCache() {
  cachedData = null;
  fetchPromise = null;
}
