"use client";

import { inputClasses, labelClasses } from "@/lib/form-styles";
import { Toggle } from "@/components/ui/toggle";
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
  contactEmailsMap: Record<number, string[]>;
  inviteEmailMap: Record<number, string>;
  setInviteEmailMap: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  excludedInviteIds: Set<number>;
  setExcludedInviteIds: React.Dispatch<React.SetStateAction<Set<number>>>;
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
  excludedInviteIds,
  setExcludedInviteIds,
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
          className={`${inputClasses} !h-auto py-4`}
          rows={3}
          placeholder="Things to remember, topics to discuss, questions to ask..."
        />
      </div>

      {/* Google Calendar section */}
      {calendarConnected && (
        <div className="border-t border-outline-variant pt-6 space-y-5">
          <label className="flex items-center gap-4 cursor-pointer">
            <Toggle
              checked={addToCalendar}
              onChange={(next) => {
                setAddToCalendar(next);
                if (!next) setIncludeMeetLink(false);
              }}
            />
            <span className="text-base text-foreground">Add to Google Calendar</span>
          </label>

          {/* Per-contact invite toggles */}
          {selectedContacts.length > 0 && (
            <div className="space-y-2.5">
              {selectedContacts.map((contact) => {
                const emails = contactEmailsMap[contact.id] || [];
                const hasEmail = emails.length > 0;
                const inviteEnabled = addToCalendar && hasEmail;
                const isInvited = inviteEnabled && !excludedInviteIds.has(contact.id);

                return (
                  <div key={contact.id} className="flex items-center gap-4">
                    <label className="flex items-center gap-4 cursor-pointer flex-1 min-w-0">
                      <Toggle
                        checked={isInvited}
                        disabled={!addToCalendar || !hasEmail}
                        onChange={() => {
                          setExcludedInviteIds((prev) => {
                            const next = new Set(prev);
                            if (isInvited) {
                              next.add(contact.id);
                            } else {
                              next.delete(contact.id);
                            }
                            return next;
                          });
                        }}
                      />
                      <span className="text-base text-foreground truncate">
                        Invite {contact.name}
                      </span>
                    </label>
                    {!hasEmail && addToCalendar && (
                      <span className="text-xs text-tertiary shrink-0">No email</span>
                    )}
                    {!addToCalendar && (
                      <span className="text-xs text-muted-foreground shrink-0">Enable calendar first</span>
                    )}
                    {hasEmail && emails.length > 1 && inviteEnabled && (
                      <select
                        value={inviteEmailMap[contact.id] || emails[0]}
                        onChange={(e) => setInviteEmailMap((prev) => ({ ...prev, [contact.id]: e.target.value }))}
                        className="text-sm bg-surface-container-low border border-outline rounded px-2.5 py-1.5 text-foreground"
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
              <div>
                <label className={labelClasses}>
                  Calendar invite description (optional)
                </label>
                <textarea
                  value={form.calendarDescription}
                  onChange={(e) => setForm((prev) => ({ ...prev, calendarDescription: e.target.value }))}
                  className={`${inputClasses} !h-auto py-4`}
                  rows={2}
                  placeholder="Agenda, dial-in details, or notes for the invite..."
                />
              </div>

              <label className="flex items-center gap-4 cursor-pointer">
                <Toggle checked={includeMeetLink} onChange={setIncludeMeetLink} />
                <span className="text-base text-foreground">Include Google Meet link</span>
              </label>

              <div>
                <label className={labelClasses}>Duration</label>
                <div className="flex flex-wrap gap-2">
                  {DURATION_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setMeetingDuration(opt.value)}
                      className={`px-4 py-1.5 rounded-full text-sm font-medium cursor-pointer transition-colors ${
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
