/**
 * Activity page (route: /meetings) — unified timeline of meetings + interactions
 *
 * Displays meetings and interactions in a single reverse-chronological feed.
 * Meeting cards show attendees, notes, transcript, and inline-editable action items.
 * Interaction cards show contact, type, and summary.
 *
 * Key features:
 *   - "Add meeting" modal: date, time, type, contacts, notes, transcript, action items
 *   - "Add interaction" modal: contact (from all contacts), date, type, summary
 *   - Inline action item editing on meeting cards (title, description, contacts, due date)
 *   - Unsaved-changes guard on scrim click for both modals
 *   - Delete interaction from timeline
 *
 * Data flow:
 *   loadMeetings() → getMeetings(userId) + getActionItemsForMeeting per meeting
 *   loadInteractions() → getAllInteractions(userId)
 *   Timeline merges both arrays sorted by date descending
 */

"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/components/auth-provider";
import { useToast } from "@/components/ui/toast";
import Navigation from "@/components/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getMeetings, deleteMeeting, getContacts, getActionItemsForMeeting, updateActionItem, deleteActionItem, replaceContactsForActionItem, getAllInteractions, deleteInteraction, uploadAttachment, addAttachmentToMeeting, getAttachmentsForMeeting, getAttachmentUrl, deleteAttachment, getTranscriptSegments, updateSpeakerContact } from "@/lib/queries";
import type { Meeting, SimpleContact, ActionItemWithContacts, MeetingActionsMap, InteractionWithContact, TranscriptSegment } from "@/lib/types";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { Plus, Calendar, X, Search, Pencil, CheckSquare, Trash2, Check, RotateCcw, MessageSquare, Paperclip, Video, AlertCircle } from "lucide-react";
import Link from "next/link";
import { DatePicker } from "@/components/ui/date-picker";
import { ContactPicker } from "@/components/ui/contact-picker";
import TranscriptViewer from "@/components/transcript-viewer";
import SpeakerResolver from "@/components/speaker-resolver";
import { TranscriptActionSuggestions } from "@/components/meetings/transcript-action-suggestions";
import { useGmailConnection } from "@/hooks/use-gmail-connection";
import { useQuickCapture } from "@/components/quick-capture-context";

import { inputClasses, labelClasses } from "@/lib/form-styles";

export default function MeetingsPage() {
  const { user } = useAuth();
  const { success: toastSuccess, error: toastError } = useToast();
  const { calendarConnected } = useGmailConnection();
  const { open: openConversationModal, openEdit: openEditModal } = useQuickCapture();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [allContacts, setAllContacts] = useState<SimpleContact[]>([]);
  const [meetingActions, setMeetingActions] = useState<MeetingActionsMap>({});
  const [cardEditActionId, setCardEditActionId] = useState<number | null>(null);
  const [cardEditTitle, setCardEditTitle] = useState("");
  const [cardEditDescription, setCardEditDescription] = useState("");
  const [cardEditDueDate, setCardEditDueDate] = useState("");
  const [cardEditContactIds, setCardEditContactIds] = useState<number[]>([]);

  // Attachments per meeting
  const [meetingAttachments, setMeetingAttachments] = useState<Record<number, { id: number; file_name: string; content_type: string | null; file_size_bytes: number | null; object_path: string }[]>>({});
  const [attachmentUploading, setAttachmentUploading] = useState<number | null>(null);

  // Interactions (still displayed in timeline until Phase 2 migration)
  const [allInteractions, setAllInteractions] = useState<InteractionWithContact[]>([]);

  // Calendar event data for timeline RSVP badges
  const [meetingCalendarMap, setMeetingCalendarMap] = useState<Record<number, { google_event_id: string; attendees: Array<{ email: string; name: string; responseStatus: string }> }>>({});

  // Search
  const [searchQuery, setSearchQuery] = useState("");

  // Transcript segments for timeline display
  const [meetingSegments, setMeetingSegments] = useState<Record<number, TranscriptSegment[]>>({});
  const [showSpeakerResolver, setShowSpeakerResolver] = useState<number | null>(null);

  const loadContacts = useCallback(async () => {
    if (!user) return;
    try {
      const data = await getContacts(user.id);
      const contacts = (data as any[]).map((c) => ({
        id: c.id,
        name: c.name,
        photo_url: c.photo_url,
      }));
      setAllContacts(contacts);
    } catch (e) { console.error("Error loading contacts:", e); }
  }, [user]);

  const loadInteractions = useCallback(async () => {
    if (!user) return;
    try {
      const data = await getAllInteractions(user.id);
      setAllInteractions(data as unknown as InteractionWithContact[]);
    } catch (e) { console.error("Error loading interactions:", e); }
  }, [user]);

  const loadMeetings = useCallback(async () => {
    if (!user) return;
    try {
      const data = await getMeetings(user.id);
      setMeetings(data as unknown as Meeting[]);

      // Load calendar events for meetings that have a linked calendar_event_id
      const typedMeetings = data as unknown as Meeting[];
      const calEventIds = typedMeetings.map(m => m.calendar_event_id).filter(Boolean);
      if (calEventIds.length > 0) {
        try {
          const { createSupabaseBrowserClient } = await import("@/lib/supabase/browser-client");
          const supabase = createSupabaseBrowserClient();
          const { data: calEvents } = await supabase
            .from("calendar_events")
            .select("google_event_id, attendees")
            .in("google_event_id", calEventIds)
            .eq("user_id", user.id);
          if (calEvents) {
            const calMap: Record<number, { google_event_id: string; attendees: Array<{ email: string; name: string; responseStatus: string }> }> = {};
            for (const m of typedMeetings) {
              const ce = calEvents.find((c: any) => c.google_event_id === m.calendar_event_id);
              if (ce) calMap[m.id] = { google_event_id: ce.google_event_id, attendees: ce.attendees || [] };
            }
            setMeetingCalendarMap(calMap);
          }
        } catch {}
      }
      // Load action items, attachments, and transcript segments for each meeting
      const actionsMap: MeetingActionsMap = {};
      const attMap: typeof meetingAttachments = {};
      const segMap: Record<number, TranscriptSegment[]> = {};
      await Promise.all(data.map(async (m) => {
        try {
          const promises: Promise<any>[] = [
            getActionItemsForMeeting(m.id),
            getAttachmentsForMeeting(m.id),
          ];
          // Only load segments for meetings that have parsed transcripts
          if (m.transcript_parsed) {
            promises.push(getTranscriptSegments(m.id));
          }
          const [items, atts, segs] = await Promise.all(promises);
          if (items.length > 0) actionsMap[m.id] = items as ActionItemWithContacts[];
          if (atts.length > 0) attMap[m.id] = atts as typeof meetingAttachments[number];
          if (segs?.length > 0) segMap[m.id] = segs as TranscriptSegment[];
        } catch {}
      }));
      setMeetingActions(actionsMap);
      setMeetingAttachments(attMap);
      setMeetingSegments(segMap);
    }
    catch (e) { console.error("Error loading meetings:", e); }
    finally { setLoading(false); }
  }, [user]);

  useEffect(() => {
    if (user) {
      loadMeetings();
      loadContacts();
      loadInteractions();
    }
  }, [user, loadMeetings, loadContacts, loadInteractions]);

  // Refresh when a conversation is logged via the unified modal
  useEffect(() => {
    const handler = () => {
      loadMeetings();
      loadInteractions();
    };
    window.addEventListener("careervine:conversation-logged", handler);
    return () => window.removeEventListener("careervine:conversation-logged", handler);
  }, [loadMeetings, loadInteractions]);

  const reloadMeetingActions = async (meetingId: number) => {
    try {
      const items = await getActionItemsForMeeting(meetingId);
      setMeetingActions(prev => ({ ...prev, [meetingId]: items as ActionItemWithContacts[] }));
    } catch {}
  };

  const handleMeetingAttachmentUpload = async (meetingId: number, e: React.ChangeEvent<HTMLInputElement>) => {
    if (!user || !e.target.files?.length) return;
    setAttachmentUploading(meetingId);
    try {
      for (const file of Array.from(e.target.files)) {
        const attachment = await uploadAttachment(user.id, file);
        await addAttachmentToMeeting(meetingId, attachment.id);
      }
      const atts = await getAttachmentsForMeeting(meetingId);
      setMeetingAttachments(prev => ({ ...prev, [meetingId]: atts as typeof meetingAttachments[number] }));
    } catch (err) {
      toastError("Failed to upload attachment");
    } finally {
      setAttachmentUploading(null);
      e.target.value = "";
    }
  };

  const handleMeetingAttachmentDownload = async (objectPath: string, fileName: string) => {
    try {
      const url = await getAttachmentUrl(objectPath);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.target = "_blank";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err) {
      toastError("Failed to download attachment");
    }
  };

  const handleMeetingAttachmentDelete = async (meetingId: number, attachmentId: number, objectPath: string) => {
    try {
      await deleteAttachment(attachmentId, objectPath);
      setMeetingAttachments(prev => ({
        ...prev,
        [meetingId]: (prev[meetingId] || []).filter(a => a.id !== attachmentId),
      }));
    } catch (err) {
      toastError("Failed to delete attachment");
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <div className="flex items-center gap-3 text-muted-foreground">
            <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
            <span className="text-sm">Loading meetings…</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        {/* Header */}
        <div className="flex justify-between items-center mb-10">
          <div>
            <h1 className="text-[28px] leading-9 font-normal text-foreground">Activity</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {meetings.length} {meetings.length === 1 ? "meeting" : "meetings"} · {allInteractions.length} {allInteractions.length === 1 ? "interaction" : "interactions"}
            </p>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => openConversationModal()}>
              <Plus className="h-[18px] w-[18px]" /> Log conversation
            </Button>
          </div>
        </div>

        {/* Calendar not connected banner */}
        {!calendarConnected && !loading && (
          <div className="flex gap-3 p-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 mb-5">
            <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                Google Calendar not connected
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                Connect your Google Calendar to add meetings to your calendar and generate Google Meet links.{" "}
                <Link href="/settings?tab=integrations" className="underline font-medium">
                  Go to Integrations
                </Link>
              </p>
            </div>
          </div>
        )}

        {/* Search bar */}
        <div className="relative mb-6">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search meetings and interactions…"
            className="w-full h-11 pl-10 pr-4 bg-surface-container-low text-foreground rounded-full border border-outline-variant placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:border-2 transition-colors text-sm"
          />
        </div>


        {/* Empty state */}
        {meetings.length === 0 && allInteractions.length === 0 && (
          <Card variant="outlined" className="text-center py-16">
            <CardContent>
              <Calendar className="mx-auto h-12 w-12 text-muted-foreground/40 mb-4" />
              <p className="text-base text-foreground mb-1">No activity yet</p>
              <p className="text-sm text-muted-foreground mb-2">
                Record coffee chats, calls, and casual interactions to build a history with your contacts.
              </p>
              <p className="text-xs text-muted-foreground mb-6">
                Meetings support notes, transcripts, and action items. Interactions are lighter — just a date and summary.
              </p>
              <div className="flex justify-center gap-2">
                <Button onClick={() => openConversationModal()}>
                  <Plus className="h-[18px] w-[18px]" /> Log conversation
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Unified timeline: meetings + interactions sorted by date desc */}
        <div className="space-y-3">
          {(() => {
            const q = searchQuery.toLowerCase().trim();
            const matchesMeeting = (m: Meeting) => {
              if (!q) return true;
              const title = (m as any).title || "";
              const names = m.meeting_contacts.map(mc => mc.contacts?.name || "").join(" ");
              return (
                title.toLowerCase().includes(q) ||
                m.meeting_type.toLowerCase().includes(q) ||
                (m.notes || "").toLowerCase().includes(q) ||
                ((m as any).private_notes || "").toLowerCase().includes(q) ||
                names.toLowerCase().includes(q)
              );
            };
            const matchesInteraction = (i: InteractionWithContact) => {
              if (!q) return true;
              return (
                (i.interaction_type || "").toLowerCase().includes(q) ||
                (i.summary || "").toLowerCase().includes(q) ||
                (i.contacts?.name || "").toLowerCase().includes(q)
              );
            };

            const timeline: { kind: "meeting" | "interaction"; date: string; data: Meeting | InteractionWithContact }[] = [
              ...meetings.filter(matchesMeeting).map((m) => ({ kind: "meeting" as const, date: m.meeting_date, data: m })),
              ...allInteractions.filter(matchesInteraction).map((i) => ({ kind: "interaction" as const, date: i.interaction_date, data: i })),
            ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

            if (timeline.length === 0 && q) {
              return (
                <div className="text-center py-16 text-muted-foreground text-sm">
                  No results for &ldquo;{searchQuery}&rdquo;
                </div>
              );
            }

            return timeline.map((item) => item.kind === "interaction" ? (
              <div key={`i-${(item.data as InteractionWithContact).id}`} className="rounded-[16px] border border-outline-variant/60 bg-white hover:border-outline-variant hover:shadow-sm transition-all duration-200">
                <div className="p-5">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-4 min-w-0">
                      <div className="w-14 h-14 rounded-full bg-primary-container flex items-center justify-center shrink-0">
                        <MessageSquare className="h-6 w-6 text-on-primary-container" />
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-base font-medium text-foreground capitalize">{(item.data as InteractionWithContact).interaction_type}</h3>
                        <p className="text-sm text-muted-foreground">
                          {new Date((item.data as InteractionWithContact).interaction_date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={async () => {
                        if (!confirm("Delete this interaction?")) return;
                        try {
                          await deleteInteraction((item.data as InteractionWithContact).id);
                          await loadInteractions();
                        } catch {}
                      }}
                      className="p-2 rounded-full text-muted-foreground hover:text-destructive cursor-pointer transition-colors"
                    >
                      <Trash2 className="h-[18px] w-[18px]" />
                    </button>
                  </div>
                  <div className="mt-2 ml-[52px]">
                    <span className="inline-flex items-center h-7 px-3 rounded-full bg-primary-container text-xs text-on-primary-container font-medium">
                      {(item.data as InteractionWithContact).contacts?.name}
                    </span>
                  </div>
                  {(item.data as InteractionWithContact).summary && (
                    <div className="mt-3 ml-[52px]">
                      <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{(item.data as InteractionWithContact).summary}</p>
                    </div>
                  )}
                </div>
              </div>
            ) : (() => {
              const meeting = item.data as Meeting;
              return (
            <div key={`m-${meeting.id}`} className="rounded-[16px] border border-outline-variant/60 bg-white hover:border-outline-variant hover:shadow-sm transition-all duration-200">
              <div className="p-5">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-4 min-w-0">
                    <div className="w-14 h-14 rounded-full bg-secondary-container flex items-center justify-center shrink-0">
                      <Calendar className="h-6 w-6 text-on-secondary-container" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-base font-medium text-foreground">{(meeting as any).title || <span className="capitalize">{meeting.meeting_type}</span>}</h3>
                      <p className="text-sm text-muted-foreground">
                        {new Date(meeting.meeting_date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
                        {" · "}
                        {new Date(meeting.meeting_date).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => openEditModal(meeting, meetingActions[meeting.id] || [])} className="p-2 rounded-full text-muted-foreground hover:text-primary cursor-pointer transition-colors">
                      <Pencil className="h-[18px] w-[18px]" />
                    </button>
                    <button
                      onClick={async () => {
                        if (!confirm("Delete this meeting? This action cannot be undone.")) return;
                        try {
                          await deleteMeeting(meeting.id);
                          await loadMeetings();
                          toastSuccess("Meeting deleted");
                        } catch (err) {
                          toastError("Failed to delete meeting");
                        }
                      }}
                      className="p-2 rounded-full text-muted-foreground hover:text-destructive cursor-pointer transition-colors"
                    >
                      <Trash2 className="h-[18px] w-[18px]" />
                    </button>
                  </div>
                </div>

                {meeting.meeting_contacts.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-3 ml-[52px]">
                    {meeting.meeting_contacts.map((mc: Meeting["meeting_contacts"][0]) => {
                      const calEvent = meetingCalendarMap[meeting.id];
                      const contactEmail = allContacts.find(c => c.id === mc.contact_id)?.email;
                      const rsvp = calEvent && contactEmail
                        ? calEvent.attendees.find((a) => a.email === contactEmail)?.responseStatus
                        : undefined;
                      const rsvpStyle = rsvp === "accepted" ? " text-primary" : rsvp === "declined" ? " text-destructive" : rsvp === "tentative" ? " text-yellow-600" : "";
                      const rsvpLabel = rsvp === "accepted" ? " ✓" : rsvp === "declined" ? " ✗" : rsvp === "tentative" ? " ?" : "";
                      return (
                        <span key={mc.contact_id} className="inline-flex items-center h-7 px-3 rounded-full bg-secondary-container text-xs text-on-secondary-container font-medium">
                          {mc.contacts.name}
                          {rsvpLabel && <span className={`ml-1 font-bold${rsvpStyle}`}>{rsvpLabel}</span>}
                        </span>
                      );
                    })}
                    {meetingCalendarMap[meeting.id] && (
                      <span className="inline-flex items-center h-7 px-2.5 rounded-full bg-primary/10 text-[11px] text-primary font-medium gap-1">
                        <Calendar className="h-3 w-3" />
                        On calendar
                      </span>
                    )}
                  </div>
                )}

                {(meeting as any).private_notes && (
                  <div className="mt-4 ml-[52px]">
                    <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">Private reminders</h4>
                    <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{(meeting as any).private_notes}</p>
                  </div>
                )}

                {meeting.notes && (
                  <div className="mt-4 ml-[52px]">
                    <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">Notes</h4>
                    <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{meeting.notes}</p>
                  </div>
                )}

                {(meeting.transcript || meetingSegments[meeting.id]?.length > 0) && (
                  <div className="mt-4 ml-[52px]">
                    <div className="flex items-center justify-between mb-1.5">
                      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Transcript</h4>
                      {meetingSegments[meeting.id]?.length > 0 && (
                        <button
                          type="button"
                          className="text-xs text-primary hover:underline cursor-pointer"
                          onClick={() => setShowSpeakerResolver(showSpeakerResolver === meeting.id ? null : meeting.id)}
                        >
                          {showSpeakerResolver === meeting.id ? "Hide" : "Match speakers"}
                        </button>
                      )}
                    </div>
                    {showSpeakerResolver === meeting.id && meetingSegments[meeting.id] && (
                      <div className="mb-3">
                        <SpeakerResolver
                          segments={meetingSegments[meeting.id]}
                          meetingContacts={meeting.meeting_contacts.map(mc => ({ id: mc.contacts.id, name: mc.contacts.name }))}
                          allContacts={allContacts}
                          meetingTitle={(meeting as any).title || undefined}
                          onResolve={async (mappings) => {
                            try {
                              await Promise.all(mappings.map(m =>
                                updateSpeakerContact(meeting.id, m.speakerLabel, m.contactId)
                              ));
                              // Reload segments
                              const segs = await getTranscriptSegments(meeting.id);
                              setMeetingSegments(prev => ({ ...prev, [meeting.id]: segs }));
                              setShowSpeakerResolver(null);
                              toastSuccess("Speaker mappings saved");
                            } catch {
                              toastError("Failed to save speaker mappings");
                            }
                          }}
                          onDismiss={() => setShowSpeakerResolver(null)}
                        />
                      </div>
                    )}
                    <TranscriptViewer
                      segments={meetingSegments[meeting.id]}
                      rawText={meeting.transcript}
                    />
                    {meeting.transcript && user && (
                      <TranscriptActionSuggestions
                        meetingId={meeting.id}
                        userId={user.id}
                        userName={user.user_metadata?.first_name || user.user_metadata?.name || undefined}
                        transcript={meeting.transcript}
                        attendees={meeting.meeting_contacts.map((mc) => ({ id: mc.contacts.id, name: mc.contacts.name }))}
                        meetingDate={meeting.meeting_date}
                        onActionCreated={() => reloadMeetingActions(meeting.id)}
                      />
                    )}
                  </div>
                )}

                {meetingActions[meeting.id] && meetingActions[meeting.id].length > 0 && (
                  <div className="mt-4 ml-[52px]">
                    <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">Action items</h4>
                    <div className="space-y-1.5">
                      {meetingActions[meeting.id].map((action) => (
                        cardEditActionId === action.id ? (
                          <div key={action.id} className="p-3 rounded-[8px] bg-surface-container space-y-2">
                            <input type="text" value={cardEditTitle} onChange={(e) => setCardEditTitle(e.target.value)} className={`${inputClasses} !h-10 text-sm`} placeholder="Title" />
                            <textarea value={cardEditDescription} onChange={(e) => setCardEditDescription(e.target.value)} className={`${inputClasses} !h-auto py-2 text-sm`} rows={2} placeholder="Description (optional)" />
                            <ContactPicker allContacts={allContacts} selectedIds={cardEditContactIds} onChange={setCardEditContactIds} />
                            <DatePicker value={cardEditDueDate} onChange={setCardEditDueDate} placeholder="No due date" />
                            <div className="flex justify-end gap-2">
                              <Button type="button" variant="text" size="sm" onClick={() => setCardEditActionId(null)}>Cancel</Button>
                              <Button type="button" size="sm" onClick={async () => {
                                try {
                                  await updateActionItem(action.id, { title: cardEditTitle.trim(), description: cardEditDescription.trim() || null, due_at: cardEditDueDate || null });
                                  await replaceContactsForActionItem(action.id, cardEditContactIds);
                                  await reloadMeetingActions(meeting.id);
                                  setCardEditActionId(null);
                                } catch (err) { console.error("Error updating action:", err); }
                              }}>Save</Button>
                            </div>
                          </div>
                        ) : (
                          <div key={action.id} className="flex items-center gap-2 text-sm group">
                            <CheckSquare className={`h-3.5 w-3.5 shrink-0 ${action.is_completed ? "text-primary" : "text-muted-foreground"}`} />
                            <span className={`flex-1 min-w-0 truncate ${action.is_completed ? "line-through text-muted-foreground" : "text-foreground"}`}>{action.title}</span>
                            <span className="text-xs text-muted-foreground shrink-0">{(action.action_item_contacts?.map(ac => ac.contacts?.name).filter(Boolean).join(", ")) || action.contacts?.name || ""}</span>
                            {action.due_at && (
                              <span className={`text-xs shrink-0 ${new Date(action.due_at) < new Date() && !action.is_completed ? "text-destructive font-medium" : "text-muted-foreground"}`}>
                                {new Date(action.due_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                              </span>
                            )}
                            <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button type="button" onClick={() => { setCardEditActionId(action.id); setCardEditTitle(action.title); setCardEditDescription(action.description || ""); setCardEditDueDate(action.due_at ? action.due_at.split("T")[0] : ""); setCardEditContactIds(action.action_item_contacts?.map(ac => ac.contact_id) || (action.contacts ? [action.contacts.id] : [])); }} className="p-1 rounded-full text-muted-foreground hover:text-foreground cursor-pointer" title="Edit">
                                <Pencil className="h-3 w-3" />
                              </button>
                              {action.is_completed ? (
                                <button type="button" onClick={async () => { try { await updateActionItem(action.id, { is_completed: false, completed_at: null }); await reloadMeetingActions(meeting.id); } catch {} }} className="p-1 rounded-full text-muted-foreground hover:text-primary cursor-pointer" title="Restore">
                                  <RotateCcw className="h-3 w-3" />
                                </button>
                              ) : (
                                <button type="button" onClick={async () => { try { await updateActionItem(action.id, { is_completed: true, completed_at: new Date().toISOString() }); await reloadMeetingActions(meeting.id); } catch {} }} className="p-1 rounded-full text-muted-foreground hover:text-primary cursor-pointer" title="Mark done">
                                  <Check className="h-3 w-3" />
                                </button>
                              )}
                              <button type="button" onClick={async () => { if (!confirm("Delete this action item?")) return; try { await deleteActionItem(action.id); await reloadMeetingActions(meeting.id); } catch {} }} className="p-1 rounded-full text-muted-foreground hover:text-destructive cursor-pointer" title="Delete">
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </div>
                          </div>
                        )
                      ))}
                    </div>
                  </div>
                )}

                {/* Attachments */}
                <div className="mt-4 ml-[52px]">
                  {meetingAttachments[meeting.id] && meetingAttachments[meeting.id].length > 0 && (
                    <div className="mb-2">
                      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">Attachments</h4>
                      <div className="space-y-1">
                        {meetingAttachments[meeting.id].map((att) => (
                          <div key={att.id} className="flex items-center gap-2 text-sm group">
                            <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <button
                              type="button"
                              className="text-primary hover:underline truncate max-w-[200px] cursor-pointer text-left"
                              onClick={() => handleMeetingAttachmentDownload(att.object_path, att.file_name)}
                            >
                              {att.file_name}
                            </button>
                            {att.file_size_bytes && (
                              <span className="text-xs text-muted-foreground">
                                {att.file_size_bytes < 1024 ? `${att.file_size_bytes} B`
                                  : att.file_size_bytes < 1048576 ? `${(att.file_size_bytes / 1024).toFixed(0)} KB`
                                  : `${(att.file_size_bytes / 1048576).toFixed(1)} MB`}
                              </span>
                            )}
                            <button
                              type="button"
                              className="ml-auto opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-600 transition-all cursor-pointer"
                              onClick={() => handleMeetingAttachmentDelete(meeting.id, att.id, att.object_path)}
                              title="Delete attachment"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <label className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80 cursor-pointer transition-colors">
                    <Paperclip className="h-3.5 w-3.5" />
                    {attachmentUploading === meeting.id ? "Uploading…" : "Attach file"}
                    <input
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => handleMeetingAttachmentUpload(meeting.id, e)}
                      disabled={attachmentUploading === meeting.id}
                    />
                  </label>
                </div>

              </div>
            </div>
              );
            })()
            );
          })()}
        </div>
      </div>

    </div>
  );
}
