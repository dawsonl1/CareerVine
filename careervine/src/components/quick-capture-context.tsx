"use client";

import { createContext, useContext, useState, useCallback } from "react";
import type { Meeting, ActionItemWithContacts } from "@/lib/types";

/** Optional pre-fill data for new conversations (e.g. from a calendar event) */
export interface QuickCapturePrefill {
  contactId?: number;
  title?: string;
  date?: string;      // YYYY-MM-DD
  time?: string;      // HH:MM
  meetingType?: string;
}

type QuickCaptureContextValue = {
  isOpen: boolean;
  prefillContactId: number | null;
  prefillData: QuickCapturePrefill | null;
  editMeeting: Meeting | null;
  editMeetingActions: ActionItemWithContacts[];
  open: (contactIdOrPrefill?: number | QuickCapturePrefill) => void;
  openEdit: (meeting: Meeting, actions: ActionItemWithContacts[]) => void;
  close: () => void;
};

const QuickCaptureContext = createContext<QuickCaptureContextValue>({
  isOpen: false,
  prefillContactId: null,
  prefillData: null,
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
  const [prefillData, setPrefillData] = useState<QuickCapturePrefill | null>(null);
  const [editMeeting, setEditMeeting] = useState<Meeting | null>(null);
  const [editMeetingActions, setEditMeetingActions] = useState<ActionItemWithContacts[]>([]);

  const open = useCallback((contactIdOrPrefill?: number | QuickCapturePrefill) => {
    if (typeof contactIdOrPrefill === "object") {
      setPrefillData(contactIdOrPrefill);
      setPrefillContactId(contactIdOrPrefill.contactId ?? null);
    } else {
      setPrefillData(null);
      setPrefillContactId(contactIdOrPrefill ?? null);
    }
    setEditMeeting(null);
    setEditMeetingActions([]);
    setIsOpen(true);
  }, []);

  const openEdit = useCallback((meeting: Meeting, actions: ActionItemWithContacts[]) => {
    setEditMeeting(meeting);
    setEditMeetingActions(actions);
    setPrefillContactId(null);
    setPrefillData(null);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setPrefillContactId(null);
    setPrefillData(null);
    setEditMeeting(null);
    setEditMeetingActions([]);
  }, []);

  return (
    <QuickCaptureContext.Provider
      value={{ isOpen, prefillContactId, prefillData, editMeeting, editMeetingActions, open, openEdit, close }}
    >
      {children}
    </QuickCaptureContext.Provider>
  );
}
