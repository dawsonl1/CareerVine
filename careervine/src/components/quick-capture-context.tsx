"use client";

import { createContext, useContext, useState, useCallback } from "react";

type QuickCaptureContextValue = {
  isOpen: boolean;
  prefillContactId: number | null;
  open: (contactId?: number) => void;
  close: () => void;
};

const QuickCaptureContext = createContext<QuickCaptureContextValue>({
  isOpen: false,
  prefillContactId: null,
  open: () => {},
  close: () => {},
});

export function useQuickCapture() {
  return useContext(QuickCaptureContext);
}

export function QuickCaptureProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [prefillContactId, setPrefillContactId] = useState<number | null>(null);

  const open = useCallback((contactId?: number) => {
    setPrefillContactId(contactId ?? null);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setPrefillContactId(null);
  }, []);

  return (
    <QuickCaptureContext.Provider value={{ isOpen, prefillContactId, open, close }}>
      {children}
    </QuickCaptureContext.Provider>
  );
}
