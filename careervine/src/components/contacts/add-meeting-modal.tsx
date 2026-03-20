"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ConfirmDiscardDialog } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { createMeeting, addContactsToMeeting, getMeetingsForContact } from "@/lib/queries";
import type { ContactMeeting } from "@/lib/types";
import { inputClasses, labelClasses } from "@/lib/form-styles";
import { MEETING_TYPE_OPTIONS } from "@/lib/constants";

interface AddMeetingModalProps {
  contactId: number;
  userId: string;
  onClose: () => void;
  onMeetingsChange: (meetings: ContactMeeting[]) => void;
}

export function AddMeetingModal({ contactId, userId, onClose, onMeetingsChange }: AddMeetingModalProps) {
  const { error: toastError } = useToast();
  const [saving, setSaving] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [form, setForm] = useState({
    date: new Date().toISOString().split("T")[0],
    time: "",
    meeting_type: "",
    notes: "",
  });

  const hasUnsavedChanges = !!(form.meeting_type || form.notes.trim() || form.time);

  const attemptClose = useCallback(() => {
    if (hasUnsavedChanges) {
      setShowConfirm(true);
    } else {
      onClose();
    }
  }, [hasUnsavedChanges, onClose]);

  const handleSave = async () => {
    if (!form.date || !form.meeting_type) return;
    setSaving(true);
    try {
      const dateTime = form.time
        ? `${form.date}T${form.time}:00`
        : `${form.date}T00:00:00`;

      const created = await createMeeting({
        user_id: userId,
        meeting_date: dateTime,
        meeting_type: form.meeting_type,
        title: null,
        notes: form.notes.trim() || null,
        private_notes: null,
        calendar_description: null,
        transcript: null,
      });

      await addContactsToMeeting(created.id, [contactId]);

      const updated = await getMeetingsForContact(contactId);
      onMeetingsChange(updated);
      onClose();
    } catch (err) {
      console.error("Error creating meeting:", err);
      toastError("Failed to create meeting");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Add meeting"
      hasUnsavedChanges={hasUnsavedChanges}
    >
      <div className="px-6 pb-6 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClasses}>Date *</label>
            <input
              type="date"
              required
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
              className={inputClasses}
            />
          </div>
          <div>
            <label className={labelClasses}>Time</label>
            <input
              type="time"
              value={form.time}
              onChange={(e) => setForm({ ...form, time: e.target.value })}
              className={inputClasses}
            />
          </div>
        </div>
        <div>
          <label className={labelClasses}>Type *</label>
          <Select
            value={form.meeting_type}
            onChange={(val) => setForm({ ...form, meeting_type: val })}
            placeholder="Select type..."
            options={MEETING_TYPE_OPTIONS}
          />
        </div>
        <div>
          <label className={labelClasses}>Notes</label>
          <textarea
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            className={`${inputClasses} !h-auto py-3`}
            rows={4}
            placeholder="Key takeaways, topics discussed..."
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="text" onClick={attemptClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!form.date || !form.meeting_type || saving}
            loading={saving}
            onClick={handleSave}
          >
            Create
          </Button>
        </div>
      </div>

      {showConfirm && (
        <ConfirmDiscardDialog
          message="You have unsaved changes that will be lost."
          onDiscard={() => { setShowConfirm(false); onClose(); }}
          onKeepEditing={() => setShowConfirm(false)}
        />
      )}
    </Modal>
  );
}
