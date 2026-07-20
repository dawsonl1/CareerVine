"use client";

import { useEffect, useCallback, useSyncExternalStore } from "react";
import { useAuth } from "@/components/auth-provider";
import type { Capability } from "@/lib/capabilities/types";

/**
 * Client mirror of the server capability resolver (CAR-103).
 *
 * Mirrors the `use-gmail-connection` module-store pattern: one shared fetch of
 * /api/capabilities, every `useCapabilities()` consumer subscribes to the same
 * store, and it lazy-initializes once `useAuth().user` lands. No provider is
 * mounted — a module store needs none. `can(capability)` is the ONLY thing UI
 * should branch on; never a tier.
 */

type StoreState = {
  capabilities: Set<Capability>;
  loading: boolean;
};

let state: StoreState = { capabilities: new Set(), loading: true };
let fetchPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

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

function fetchCapabilities(): Promise<void> {
  if (fetchPromise) return fetchPromise;
  fetchPromise = fetch("/api/capabilities")
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((data: { capabilities?: Capability[] }) => {
      setState({ capabilities: new Set(data.capabilities ?? []), loading: false });
      fetchPromise = null;
    })
    .catch(() => {
      // Fail closed: an errored fetch leaves the free (empty) set, never a paid
      // capability. Clear loading so shells can render their free experience.
      setState({ loading: false });
      fetchPromise = null;
    });
  return fetchPromise;
}

// SSR-safe snapshot (always loading, no capabilities).
const serverSnapshot: StoreState = { capabilities: new Set(), loading: true };
function getServerSnapshot(): StoreState {
  return serverSnapshot;
}

export function useCapabilities() {
  const { user } = useAuth();
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Trigger the initial fetch once a user is available.
  useEffect(() => {
    if (!user) return;
    if (!snap.loading || fetchPromise) return; // already resolved or in-flight
    // Fire-and-forget: fetchCapabilities catches its own errors and fails closed.
    void fetchCapabilities();
  }, [user, snap.loading]);

  const refresh = useCallback(async () => {
    fetchPromise = null;
    setState({ loading: true });
    await fetchCapabilities();
  }, []);

  const can = useCallback(
    (capability: Capability) => snap.capabilities.has(capability),
    [snap.capabilities],
  );

  return { capabilities: snap.capabilities, loading: snap.loading, can, refresh };
}

/** Reset the cache (call after a reconnect / entitlement change). */
export function invalidateCapabilitiesCache() {
  fetchPromise = null;
  setState({ capabilities: new Set(), loading: true });
}
