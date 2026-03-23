"use client";

import { inputClasses, labelClasses } from "@/lib/form-styles";
import type { ConversationFormState } from "./types";

const DURATION_OPTIONS = [
  { value: 15, label: "15m" },
  { value: 30, label: "30m" },
  { value: 45, label: "45m" },
  { value: 60, label: "1h" },
  { value: 90, label: "1.5h" },
  { value: 120, label: "2h" },
] as const;

interface FutureMeetingFieldsProps {
  form: ConversationFormState;
  setForm: React.Dispatch<React.SetStateAction<ConversationFormState>>;
  calendarConnected: boolean;
  addToCalendar: boolean;
  setAddToCalendar: (v: boolean) => void;
  includeMeetLink: boolean;
  setIncludeMeetLink: (v: boolean) => void;
  meetingDuration: number;
  setMeetingDuration: (v: number) => void;
  /** Map of contactId → email addresses */
  contactEmailsMap: Record<number, string[]>;
  inviteEmailMap: Record<number, string>;
  setInviteEmailMap: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  /** Contact names for invite toggles */
  allContacts: { id: number; name: string }[];
}

export function FutureMeetingFields({
  form,
  setForm,
  calendarConnected,
  addToCalendar,
  setAddToCalendar,
  includeMeetLink,
  setIncludeMeetLink,
  meetingDuration,
  setMeetingDuration,
  contactEmailsMap,
  inviteEmailMap,
  setInviteEmailMap,
  allContacts,
}: FutureMeetingFieldsProps) {
  const selectedContacts = form.selectedContactIds
    .map((id) => ({ id, name: allContacts.find((c) => c.id === id)?.name || "Contact" }));

  return (
    <>
      {/* Private reminder notes */}
      <div>
        <label className={labelClasses}>
          Private reminder notes (optional)
        </label>
        <textarea
          value={form.privateNotes}
          onChange={(e) => setForm((prev) => ({ ...prev, privateNotes: e.target.value }))}
          className={`${inputClasses} !h-auto py-3`}
          rows={3}
          placeholder="Things to remember, topics to discuss, questions to ask..."
        />
      </div>

      {/* Google Calendar section */}
      {calendarConnected && (
        <div className="border-t border-outline-variant pt-5 space-y-4">
          {/* Add to Google Calendar toggle */}
          <label className="flex items-center gap-3 cursor-pointer">
            <div
              className={`relative w-10 h-6 rounded-full transition-colors ${
                addToCalendar ? "bg-primary" : "bg-outline"
              }`}
              onClick={() => {
                const next = !addToCalendar;
                setAddToCalendar(next);
                if (!next) setIncludeMeetLink(false);
              }}
            >
              <div
                className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${
                  addToCalendar ? "left-5" : "left-1"
                }`}
              />
            </div>
            <span className="text-sm text-foreground">Add to Google Calendar</span>
          </label>

          {/* Per-contact invite toggles */}
          {selectedContacts.length > 0 && (
            <div className="space-y-2">
              {selectedContacts.map((contact) => {
                const emails = contactEmailsMap[contact.id] || [];
                const hasEmail = emails.length > 0;
                const inviteEnabled = addToCalendar && hasEmail;
                const isInvited = inviteEnabled && (inviteEmailMap[contact.id] !== undefined || emails.length > 0);

                return (
                  <div key={contact.id} className="flex items-center gap-3">
                    <label className="flex items-center gap-3 cursor-pointer flex-1 min-w-0">
                      <div
                        className={`relative w-10 h-6 rounded-full transition-colors shrink-0 ${
                          isInvited ? "bg-primary" : "bg-outline"
                        } ${!addToCalendar ? "opacity-50" : ""}`}
                        onClick={() => {
                          if (!addToCalendar) return;
                          if (!hasEmail) return;
                          setInviteEmailMap((prev) => {
                            const next = { ...prev };
                            if (next[contact.id] !== undefined) {
                              delete next[contact.id];
                            } else {
                              next[contact.id] = emails[0];
                            }
                            return next;
                          });
                        }}
                      >
                        <div
                          className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${
                            isInvited ? "left-5" : "left-1"
                          }`}
                        />
                      </div>
                      <span className="text-sm text-foreground truncate">
                        Invite {contact.name}
                      </span>
                    </label>
                    {!hasEmail && addToCalendar && (
                      <span className="text-[10px] text-amber-600 dark:text-amber-400 shrink-0">No email</span>
                    )}
                    {!addToCalendar && (
                      <span className="text-[10px] text-muted-foreground shrink-0">Enable calendar first</span>
                    )}
                    {/* Email selector for multi-email contacts */}
                    {hasEmail && emails.length > 1 && inviteEnabled && (
                      <select
                        value={inviteEmailMap[contact.id] || emails[0]}
                        onChange={(e) => setInviteEmailMap((prev) => ({ ...prev, [contact.id]: e.target.value }))}
                        className="text-xs bg-surface-container-low border border-outline rounded px-2 py-1 text-foreground"
                      >
                        {emails.map((email) => (
                          <option key={email} value={email}>{email}</option>
                        ))}
                      </select>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {addToCalendar && (
            <>
              {/* Calendar description */}
              <div>
                <label className={labelClasses}>
                  Calendar invite description (optional)
                </label>
                <textarea
                  value={form.calendarDescription}
                  onChange={(e) => setForm((prev) => ({ ...prev, calendarDescription: e.target.value }))}
                  className={`${inputClasses} !h-auto py-3`}
                  rows={2}
                  placeholder="Agenda, dial-in details, or notes for the invite..."
                />
              </div>

              {/* Google Meet toggle */}
              <label className="flex items-center gap-3 cursor-pointer">
                <div
                  className={`relative w-10 h-6 rounded-full transition-colors ${
                    includeMeetLink ? "bg-primary" : "bg-outline"
                  }`}
                  onClick={() => setIncludeMeetLink(!includeMeetLink)}
                >
                  <div
                    className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${
                      includeMeetLink ? "left-5" : "left-1"
                    }`}
                  />
                </div>
                <span className="text-sm text-foreground">Include Google Meet link</span>
              </label>

              {/* Duration chips */}
              <div>
                <label className={labelClasses}>
                  Duration
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {DURATION_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setMeetingDuration(opt.value)}
                      className={`px-3 py-1 rounded-full text-xs font-medium cursor-pointer transition-colors ${
                        meetingDuration === opt.value
                          ? "bg-secondary-container text-on-secondary-container"
                          : "bg-surface-container text-foreground hover:bg-surface-container-high"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
