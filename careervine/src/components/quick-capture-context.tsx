"use client";

import { createContext, useContext, useState, useCallback } from "react";
import type { Meeting, ActionItemWithContacts } from "@/lib/types";

type QuickCaptureContextValue = {
  isOpen: boolean;
  prefillContactId: number | null;
  editMeeting: Meeting | null;
  editMeetingActions: ActionItemWithContacts[];
  open: (contactId?: number) => void;
  openEdit: (meeting: Meeting, actions: ActionItemWithContacts[]) => void;
  close: () => void;
};

const QuickCaptureContext = createContext<QuickCaptureContextValue>({
  isOpen: false,
  prefillContactId: null,
  editMeeting: null,
  editMeetingActions: [],
  open: () => {},
  openEdit: () => {},
  close: () => {},
});

export function useQuickCapture() {
  return useContext(QuickCaptureContext);
}

export function QuickCaptureProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [prefillContactId, setPrefillContactId] = useState<number | null>(null);
  const [editMeeting, setEditMeeting] = useState<Meeting | null>(null);
  const [editMeetingActions, setEditMeetingActions] = useState<ActionItemWithContacts[]>([]);

  const open = useCallback((contactId?: number) => {
    setPrefillContactId(contactId ?? null);
    setEditMeeting(null);
    setEditMeetingActions([]);
    setIsOpen(true);
  }, []);

  const openEdit = useCallback((meeting: Meeting, actions: ActionItemWithContacts[]) => {
    setEditMeeting(meeting);
    setEditMeetingActions(actions);
    setPrefillContactId(null);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setPrefillContactId(null);
    setEditMeeting(null);
    setEditMeetingActions([]);
  }, []);

  return (
    <QuickCaptureContext.Provider
      value={{ isOpen, prefillContactId, editMeeting, editMeetingActions, open, openEdit, close }}
    >
      {children}
    </QuickCaptureContext.Provider>
  );
}
