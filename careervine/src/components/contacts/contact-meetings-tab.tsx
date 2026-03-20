"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { updateMeeting, getMeetingsForContact } from "@/lib/queries";
import type { ContactMeeting } from "@/lib/types";
import { Calendar, Pencil, X, ChevronDown } from "lucide-react";

import { inputClasses } from "@/lib/form-styles";

interface ContactMeetingsTabProps {
  contactId: number;
  meetings: ContactMeeting[];
  loading: boolean;
  onMeetingsChange: (meetings: ContactMeeting[]) => void;
}

export function ContactMeetingsTab({ contactId, meetings, loading, onMeetingsChange }: ContactMeetingsTabProps) {
  const [expandedMeetingId, setExpandedMeetingId] = useState<number | null>(null);
  const [editingMeetingId, setEditingMeetingId] = useState<number | null>(null);
  const [editNotes, setEditNotes] = useState("");
  const [editTranscript, setEditTranscript] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async (meeting: ContactMeeting) => {
    setSaving(true);
    try {
      await updateMeeting(meeting.id, {
        notes: editNotes.trim() || null,
        transcript: editTranscript.trim() || null,
      });
      const updated = await getMeetingsForContact(contactId);
      onMeetingsChange(updated);
      setEditingMeetingId(null);
    } catch (err) {
      console.error("Error updating meeting:", err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5 mb-3">
        <Calendar className="h-3.5 w-3.5" /> Meetings{meetings.length > 0 ? ` (${meetings.length})` : ""}
      </h4>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-2">
          <div className="animate-spin rounded-full h-4 w-4 border-2 border-primary border-t-transparent" />
          <span className="text-xs">Loading…</span>
        </div>
      ) : meetings.length === 0 ? (
        <p className="text-xs text-muted-foreground py-1">No meetings recorded.</p>
      ) : (
        <div className="space-y-2">
          {meetings
            .sort((a, b) => new Date(b.meeting_date).getTime() - new Date(a.meeting_date).getTime())
            .map((meeting) => {
              const isExpanded = expandedMeetingId === meeting.id;
              const isEditing = editingMeetingId === meeting.id;
              return (
                <div key={meeting.id} className="rounded-[12px] border border-outline-variant/50 overflow-hidden">
                  <button
                    type="button"
                    className="w-full text-left p-3 flex items-center gap-3 hover:bg-surface-container-low transition-colors cursor-pointer"
                    onClick={() => {
                      setExpandedMeetingId(isExpanded ? null : meeting.id);
                      setEditingMeetingId(null);
                    }}
                  >
                    <div className="w-8 h-8 rounded-full bg-secondary-container flex items-center justify-center shrink-0">
                      <Calendar className="h-3.5 w-3.5 text-on-secondary-container" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground capitalize">{meeting.meeting_type}</span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(meeting.meeting_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                          {" at "}
                          {new Date(meeting.meeting_date).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                        </span>
                      </div>
                      {!isExpanded && meeting.notes && (
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{meeting.notes}</p>
                      )}
                    </div>
                    <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform shrink-0 ${isExpanded ? "rotate-0" : "-rotate-90"}`} />
                  </button>

                  {isExpanded && (
                    <div className="px-3 pb-3 space-y-3">
                      {isEditing ? (
                        <>
                          <div>
                            <label className="block text-xs font-medium text-muted-foreground mb-1.5">Notes</label>
                            <textarea
                              value={editNotes}
                              onChange={(e) => setEditNotes(e.target.value)}
                              className={`${inputClasses} !h-auto py-3`}
                              rows={6}
                              placeholder="Key takeaways, action items…"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-muted-foreground mb-1.5">Transcript</label>
                            <textarea
                              value={editTranscript}
                              onChange={(e) => setEditTranscript(e.target.value)}
                              className={`${inputClasses} !h-auto py-3`}
                              rows={12}
                              placeholder="Paste your full meeting transcript here…"
                            />
                          </div>
                          <div className="flex justify-end gap-2">
                            <Button type="button" variant="text" size="sm" onClick={() => setEditingMeetingId(null)}>Cancel</Button>
                            <Button
                              type="button"
                              size="sm"
                              disabled={saving}
                              loading={saving}
                              onClick={() => handleSave(meeting)}
                            >
                              Save
                            </Button>
                          </div>
                        </>
                      ) : (
                        <>
                          {meeting.notes ? (
                            <div>
                              <h5 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">Notes</h5>
                              <p className="text-sm text-foreground whitespace-pre-wrap">{meeting.notes}</p>
                            </div>
                          ) : (
                            <p className="text-sm text-muted-foreground italic">No notes recorded.</p>
                          )}
                          {meeting.transcript && (
                            <div>
                              <h5 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">Transcript</h5>
                              <div className="bg-surface-container-low rounded-[8px] p-3 max-h-[40vh] overflow-y-auto">
                                <pre className="whitespace-pre-wrap text-sm text-foreground font-sans">{meeting.transcript}</pre>
                              </div>
                            </div>
                          )}
                          <div className="flex justify-end">
                            <Button
                              type="button"
                              variant="text"
                              size="sm"
                              onClick={() => {
                                setEditNotes(meeting.notes || "");
                                setEditTranscript(meeting.transcript || "");
                                setEditingMeetingId(meeting.id);
                              }}
                            >
                              <Pencil className="h-3.5 w-3.5" /> Edit
                            </Button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      )}

      <div className="mt-3">
        <Button
          type="button"
          variant="tonal"
          size="sm"
          onClick={() => { window.location.href = "/meetings"; }}
        >
          <Calendar className="h-4 w-4" /> Add meeting
        </Button>
      </div>
    </div>
  );
}
