"use client";

/**
 * Open/close plumbing for the extension-onboarding modal (CAR-68), mirroring
 * the quick-capture pattern: provider in the root layout, the home page's
 * seeded to-do row calls open(). The actionItemId rides along so the modal
 * can mark the to-do complete when the flow reaches a terminal state.
 */

import { createContext, useContext, useState, useCallback } from "react";

type ExtensionOnboardingContextValue = {
  isOpen: boolean;
  actionItemId: number | null;
  open: (actionItemId?: number) => void;
  close: () => void;
};

const ExtensionOnboardingContext = createContext<ExtensionOnboardingContextValue>({
  isOpen: false,
  actionItemId: null,
  open: () => {},
  close: () => {},
});

export function useExtensionOnboarding() {
  return useContext(ExtensionOnboardingContext);
}

export function ExtensionOnboardingProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [actionItemId, setActionItemId] = useState<number | null>(null);

  const open = useCallback((id?: number) => {
    setActionItemId(id ?? null);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => setIsOpen(false), []);

  return (
    <ExtensionOnboardingContext.Provider value={{ isOpen, actionItemId, open, close }}>
      {children}
    </ExtensionOnboardingContext.Provider>
  );
}
