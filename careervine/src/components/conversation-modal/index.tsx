"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/components/auth-provider";
import { useQuickCapture } from "@/components/quick-capture-context";
import { useToast } from "@/components/ui/toast";
import { useGmailConnection } from "@/hooks/use-gmail-connection";
import { useContactsWithEmails } from "@/hooks/use-contacts-with-emails";
import { Button } from "@/components/ui/button";
import { ContactPicker } from "@/components/ui/contact-picker";
import { DatePicker } from "@/components/ui/date-picker";
import { TimePicker } from "@/components/ui/time-picker";
import { ConfirmDiscardDialog } from "@/components/ui/modal";
import {
  createMeeting,
  updateMeeting,
  addContactsToMeeting,
  replaceContactsForMeeting,
  createActionItem,
  createTranscriptSegments,
  deleteTranscriptSegments,
  addAttachmentToMeeting,
  deleteAttachment,
} from "@/lib/queries";
import { CONVERSATION_TYPE_OPTIONS, ActionItemSource } from "@/lib/constants";
import { inputClasses, labelClasses } from "@/lib/form-styles";
import {
  X,
  Coffee,
  Phone,
  Video,
  Users,
  UtensilsCrossed,
  Building2,
  Globe,
  MessageSquare,
} from "lucide-react";
import type { SimpleContact } from "@/lib/types";
import type { ConversationFormState, PendingAction, TranscriptState } from "./types";
import { PastMeetingFields } from "./past-meeting-fields";
import { FutureMeetingFields } from "./future-meeting-fields";
import { ActionItemsSection } from "./action-items-section";

// Map icon names to components
const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  Coffee,
  Phone,
  Video,
  Users,
  UtensilsCrossed,
  Building2,
  Globe,
  MessageSquare,
};

const emptyForm: ConversationFormState = {
  selectedContactIds: [],
  title: "",
  meetingType: "",
  date: "",
  time: "",
  notes: "",
  privateNotes: "",
  transcript: "",
  calendarDescription: "",
};

const emptyTranscriptState: TranscriptState = {
  pendingSegments: [],
  pendingTranscriptSource: null,
  isTranscribing: false,
  pendingAudioAttachment: null,
};

export function ConversationModal() {
  const { user } = useAuth();
  const { isOpen, prefillContactId, editMeeting, close } = useQuickCapture();
  const { success: toastSuccess, error: toastError } = useToast();
  const { calendarConnected } = useGmailConnection();

  const { contacts: allContacts, emailsMap: contactEmailsMap } = useContactsWithEmails({ enabled: isOpen });

  const [form, setForm] = useState<ConversationFormState>(emptyForm);
  const [transcriptState, setTranscriptState] = useState<TranscriptState>(emptyTranscriptState);
  const [pendingActions, setPendingActions] = useState<PendingAction[]>([]);
  const [inviteEmailMap, setInviteEmailMap] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);
  const [showConfirmDiscard, setShowConfirmDiscard] = useState(false);

  // Calendar state
  const [addToCalendar, setAddToCalendar] = useState(false);
  const [includeMeetLink, setIncludeMeetLink] = useState(true);
  const [meetingDuration, setMeetingDuration] = useState(60);

  const savingRef = useRef(false);

  const hasDate = !!form.date;
  const isFutureMeeting = (() => {
    if (!form.date) return false;
    // Always use T00:00:00 for date-only to force local-time parsing (date-only strings parse as UTC)
    const dateStr = form.time ? `${form.date}T${form.time}` : `${form.date}T00:00:00`;
    return new Date(dateStr) > new Date();
  })();
  const isPastMeeting = hasDate && !isFutureMeeting;

  const isEditMode = !!editMeeting;

  // Track initial form snapshot to detect real changes (works for both new and edit mode)
  const [initialFormSnapshot, setInitialFormSnapshot] = useState("");
  const currentSnapshot = JSON.stringify({ ...form, pendingActions: pendingActions.length });
  const hasUnsavedChanges = currentSnapshot !== initialFormSnapshot;

  const closeAndCleanup = useCallback(() => {
    // Clean up orphaned audio attachment if user didn't save
    if (transcriptState.pendingAudioAttachment) {
      deleteAttachment(transcriptState.pendingAudioAttachment.id, transcriptState.pendingAudioAttachment.object_path).catch(() => {});
    }
    close();
  }, [close, transcriptState.pendingAudioAttachment]);

  const attemptClose = useCallback(() => {
    if (hasUnsavedChanges) {
      setShowConfirmDiscard(true);
    } else {
      closeAndCleanup();
    }
  }, [hasUnsavedChanges, closeAndCleanup]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showConfirmDiscard) {
          setShowConfirmDiscard(false);
        } else {
          attemptClose();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, attemptClose, showConfirmDiscard]);

  // Reset form when opened
  useEffect(() => {
    if (!isOpen) return;

    if (editMeeting) {
      // Edit mode: populate from existing meeting
      const d = new Date(editMeeting.meeting_date);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const timeStr = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      setForm({
        selectedContactIds: editMeeting.meeting_contacts.map((mc) => mc.contact_id),
        title: editMeeting.title || "",
        meetingType: editMeeting.meeting_type || "coffee",
        date: dateStr,
        time: timeStr,
        notes: editMeeting.notes || "",
        privateNotes: editMeeting.private_notes || "",
        transcript: editMeeting.transcript || "",
        calendarDescription: editMeeting.calendar_description || "",
      });
      setPendingActions([]);
      setTranscriptState(emptyTranscriptState);
      setInviteEmailMap({});
      setMeetingDuration(60);
      // Snapshot for edit mode discard detection
      const editForm = {
        selectedContactIds: editMeeting.meeting_contacts.map((mc) => mc.contact_id),
        title: editMeeting.title || "",
        meetingType: editMeeting.meeting_type || "coffee",
        date: dateStr,
        time: timeStr,
        notes: editMeeting.notes || "",
        privateNotes: editMeeting.private_notes || "",
        transcript: editMeeting.transcript || "",
        calendarDescription: editMeeting.calendar_description || "",
      };
      setInitialFormSnapshot(JSON.stringify({ ...editForm, pendingActions: 0 }));
    } else {
      // New mode
      const newForm = {
        ...emptyForm,
        selectedContactIds: prefillContactId ? [prefillContactId] : [],
      };
      setForm(newForm);
      setPendingActions([]);
      setTranscriptState(emptyTranscriptState);
      setInviteEmailMap({});
      setAddToCalendar(calendarConnected);
      setIncludeMeetLink(true);
      setMeetingDuration(60);
      setInitialFormSnapshot(JSON.stringify({ ...newForm, pendingActions: 0 }));
    }
  }, [isOpen, editMeeting, prefillContactId, calendarConnected]);

  const handleSave = async () => {
    if (savingRef.current || !user || form.selectedContactIds.length === 0) return;
    savingRef.current = true;
    setSaving(true);

    try {
      const dateTime = form.date && form.time
        ? `${form.date}T${form.time}`
        : form.date;

      let meetingId: number;

      const autoSummary = form.title ||
        (form.meetingType
          ? `${form.meetingType.charAt(0).toUpperCase() + form.meetingType.slice(1).replace("-", " ")} with ${form.selectedContactIds.map(id => allContacts.find(c => c.id === id)?.name).filter(Boolean).join(", ") || "Contact"}`
          : "Meeting");

      if (editMeeting) {
        // Update existing meeting
        await updateMeeting(editMeeting.id, {
          meeting_date: dateTime,
          meeting_type: form.meetingType,
          title: form.title || null,
          notes: form.notes || null,
          private_notes: form.privateNotes || null,
          calendar_description: form.calendarDescription || null,
          transcript: form.transcript || null,
        });
        await replaceContactsForMeeting(editMeeting.id, form.selectedContactIds);
        meetingId = editMeeting.id;

        // Update calendar event if one exists
        if (editMeeting.calendar_event_id) {
          try {
            const startTime = new Date(dateTime).toISOString();
            const endTime = new Date(new Date(dateTime).getTime() + meetingDuration * 60000).toISOString();
            await fetch(`/api/calendar/events/${editMeeting.calendar_event_id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                summary: autoSummary,
                description: form.calendarDescription || form.notes || undefined,
                startTime,
                endTime,
              }),
            });
          } catch { /* calendar update is best-effort */ }
        }
      } else {
        // Create new meeting
        const created = await createMeeting({
          user_id: user.id,
          meeting_date: dateTime,
          meeting_type: form.meetingType,
          title: form.title || null,
          notes: form.notes || null,
          private_notes: form.privateNotes || null,
          calendar_description: form.calendarDescription || null,
          transcript: form.transcript || null,
        });
        if (form.selectedContactIds.length > 0) {
          await addContactsToMeeting(created.id, form.selectedContactIds);
        }
        meetingId = created.id;

        // Create Google Calendar event for future meetings
        if (addToCalendar && calendarConnected && isFutureMeeting && form.time) {
          try {
            const attendeeEmails = form.selectedContactIds
              .filter((id) => inviteEmailMap[id] !== "") // skip explicitly uninvited
              .map((id) => inviteEmailMap[id] || contactEmailsMap[id]?.[0] || null)
              .filter(Boolean) as string[];

            const startTime = new Date(dateTime).toISOString();
            const endTime = new Date(new Date(dateTime).getTime() + meetingDuration * 60000).toISOString();
            await fetch("/api/calendar/create-event", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                summary: autoSummary,
                description: form.calendarDescription || undefined,
                startTime,
                endTime,
                attendeeEmails,
                conferenceType: includeMeetLink ? "meet" : "none",
                meetingId: created.id,
              }),
            });
          } catch { /* calendar creation is best-effort */ }
        }
      }

      // Create pending action items in parallel
      if (pendingActions.length > 0) {
        const now = new Date().toISOString();
        await Promise.allSettled(
          pendingActions.map((action) => {
            const contactIds = action.contactIds.length > 0
              ? action.contactIds
              : form.selectedContactIds;
            return createActionItem({
              user_id: user.id,
              contact_id: contactIds[0] || null,
              meeting_id: meetingId,
              title: action.title,
              description: action.description || null,
              due_at: action.dueAt || null,
              is_completed: false,
              created_at: now,
              completed_at: null,
              direction: action.direction,
              source: action.source === "ai_transcript" ? ActionItemSource.AiTranscript : undefined,
              suggestion_evidence: action.evidence || undefined,
              assigned_speaker: action.assignedSpeaker || undefined,
            }, contactIds);
          })
        );
      }

      // Handle transcript segments
      let segmentsToSave = transcriptState.pendingSegments;
      let sourceToSave = transcriptState.pendingTranscriptSource;
      if (segmentsToSave.length === 0 && form.transcript.length > 50) {
        const { parseTranscript } = await import("@/lib/transcript-parser");
        const result = parseTranscript(form.transcript);
        if (result.segments.length > 0 && result.confidence >= 0.3) {
          segmentsToSave = result.segments;
          sourceToSave = "paste";
        }
      }

      const serverAlreadySaved = sourceToSave === "audio_deepgram" && isEditMode;
      if (segmentsToSave.length > 0 && !serverAlreadySaved) {
        try {
          await createTranscriptSegments(meetingId, segmentsToSave);
          await updateMeeting(meetingId, {
            transcript_source: sourceToSave || "paste",
            transcript_parsed: true,
          });
        } catch (e) {
          console.warn("Failed to save transcript segments:", e);
        }
      } else if (editMeeting && editMeeting.transcript_parsed && segmentsToSave.length === 0) {
        const transcriptChanged = (form.transcript || null) !== (editMeeting.transcript || null);
        if (transcriptChanged) {
          try {
            await deleteTranscriptSegments(meetingId);
            await updateMeeting(meetingId, { transcript_parsed: false, transcript_source: null });
          } catch (e) {
            console.warn("Failed to clear stale transcript segments:", e);
          }
        }
      }

      // Link audio attachment
      if (transcriptState.pendingAudioAttachment) {
        try {
          await addAttachmentToMeeting(meetingId, transcriptState.pendingAudioAttachment.id);
          await updateMeeting(meetingId, { transcript_attachment_id: transcriptState.pendingAudioAttachment.id });
        } catch (e) {
          console.warn("Failed to link audio attachment:", e);
        }
      }

      toastSuccess(isEditMode ? "Meeting updated" : "Conversation logged");
      close();

      // Notify other components to refresh
      window.dispatchEvent(new CustomEvent("careervine:conversation-logged"));
    } catch (err) {
      console.error("Error saving:", err);
      toastError("Failed to save");
    } finally {
      setSaving(false);
      savingRef.current = false;
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={attemptClose} />

      {/* Modal */}
      <div className="relative w-full sm:max-w-2xl max-h-[100dvh] sm:max-h-[85vh] bg-background rounded-t-[28px] sm:rounded-[28px] shadow-xl overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-background z-10 flex items-center justify-between px-6 pt-6 pb-4 border-b border-outline-variant">
          <h2 className="text-lg font-medium text-foreground">
            {isEditMode ? "Edit meeting" : "Log a conversation"}
          </h2>
          <button
            onClick={attemptClose}
            className="p-2 rounded-full text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {/* Contact picker */}
          <div>
            <label className={labelClasses}>
              Who did you talk to?
            </label>
            <ContactPicker
              allContacts={allContacts}
              selectedIds={form.selectedContactIds}
              onChange={(ids) => setForm((prev) => ({ ...prev, selectedContactIds: ids }))}
              placeholder="Search contacts..."
            />
          </div>

          {/* Meeting name */}
          <div>
            <label className={labelClasses}>
              Meeting name (optional)
            </label>
            <input
              type="text"
              value={form.title}
              onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
              className={inputClasses}
              placeholder="e.g. Coffee with Alex, Informational with Jane..."
            />
          </div>

          {/* Type chips */}
          <div>
            <label className={labelClasses}>
              Type
            </label>
            <div className="flex flex-wrap gap-2">
              {CONVERSATION_TYPE_OPTIONS.map((type) => {
                const Icon = ICON_MAP[type.iconName];
                const active = form.meetingType === type.value;
                return (
                  <button
                    key={type.value}
                    type="button"
                    onClick={() => setForm((prev) => ({ ...prev, meetingType: type.value }))}
                    className={`inline-flex items-center gap-1.5 h-9 px-4 rounded-full text-sm font-medium cursor-pointer transition-colors ${
                      active
                        ? "bg-secondary-container text-on-secondary-container"
                        : "bg-surface-container text-foreground hover:bg-surface-container-high"
                    }`}
                  >
                    {Icon && <Icon className="h-4 w-4" />}
                    {type.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Date + optional Time */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className={labelClasses}>
                When
              </label>
              <DatePicker
                value={form.date}
                onChange={(val) => setForm((prev) => ({ ...prev, date: val }))}
              />
            </div>
            {hasDate && (
              <div className="w-[140px]">
                <label className={labelClasses}>
                  Time (optional)
                </label>
                <TimePicker
                  value={form.time}
                  onChange={(val) => setForm((prev) => ({ ...prev, time: val }))}
                  placeholder="Time"
                />
              </div>
            )}
          </div>

          {/* Conditional fields based on past/future — hidden until date is picked */}
          {isFutureMeeting && (
            <FutureMeetingFields
              form={form}
              setForm={setForm}
              calendarConnected={calendarConnected}
              addToCalendar={addToCalendar}
              setAddToCalendar={setAddToCalendar}
              includeMeetLink={includeMeetLink}
              setIncludeMeetLink={setIncludeMeetLink}
              meetingDuration={meetingDuration}
              setMeetingDuration={setMeetingDuration}
              contactEmailsMap={contactEmailsMap}
              inviteEmailMap={inviteEmailMap}
              setInviteEmailMap={setInviteEmailMap}
              allContacts={allContacts}
            />
          )}
          {isPastMeeting && (
            <>
              <PastMeetingFields
                form={form}
                setForm={setForm}
                transcriptState={transcriptState}
                setTranscriptState={setTranscriptState}
                meetingId={editMeeting?.id ?? null}
                userId={user?.id || ""}
                userName={user?.user_metadata?.full_name || undefined}
                allContacts={allContacts}
                onAiActionAccepted={(action) => setPendingActions((prev) => [...prev, action])}
                onActionCreated={() => {
                  window.dispatchEvent(new CustomEvent("careervine:conversation-logged"));
                }}
              />
              <ActionItemsSection
                pendingActions={pendingActions}
                onAddAction={(action) => setPendingActions((prev) => [...prev, action])}
                onRemoveAction={(index) =>
                  setPendingActions((prev) => prev.filter((_, i) => i !== index))
                }
              />
            </>
          )}
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-background border-t border-outline-variant px-6 py-4 flex justify-end gap-2">
          <Button variant="text" onClick={attemptClose}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            loading={saving}
            disabled={form.selectedContactIds.length === 0 || !form.meetingType || !form.date}
          >
            {isEditMode ? "Update" : "Save conversation"}
          </Button>
        </div>
      </div>

      {/* Confirm discard dialog */}
      {showConfirmDiscard && (
        <ConfirmDiscardDialog
          message="You have unsaved changes that will be lost."
          onDiscard={() => {
            setShowConfirmDiscard(false);
            closeAndCleanup();
          }}
          onKeepEditing={() => setShowConfirmDiscard(false)}
        />
      )}
    </div>
  );
}
