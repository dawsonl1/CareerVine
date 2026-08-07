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
 *   loadMeetings() → getMeetings(userId), then ONE batched read per related
 *     table over every meeting id (action items, attachments, transcript
 *     segments). Never fetch those per meeting: getMeetings returns up to 200,
 *     so a per-meeting fan-out is up to 600 concurrent PostgREST requests for
 *     a single list (CAR-229).
 *   loadInteractions() → getAllInteractions(userId)
 *   Timeline merges both arrays sorted by date descending
 *
 * The full contact list is NOT part of the page load. Attendee RSVP badges use
 * getFirstEmailByContactId over the attendee ids on screen; the two widgets
 * that genuinely need every contact (the action-item ContactPicker and the
 * speaker resolver) pull it through ensureAllContacts() when they open.
 */

"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { UI_EVENTS, onUiEvent } from "@/lib/ui-events";
import { useAuth } from "@/components/auth-provider";
import { useToast } from "@/components/ui/toast";
import { parseCalendarAttendees, type CalendarAttendee } from "@/lib/calendar-attendees";
import Navigation from "@/components/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getMeetings, deleteMeeting, getContacts, getActionItemsForMeeting, updateActionItem, deleteActionItem, replaceContactsForActionItem, getAllInteractions, deleteInteraction, uploadAttachment, addAttachmentToMeeting, getAttachmentsForMeeting, getAttachmentUrl, deleteAttachment, getTranscriptSegments, updateSpeakerContact } from "@/lib/queries";
// Direct domain imports: @/lib/queries is a frozen barrel, so batched reads
// added after CAR-146 are not re-exported through it (CONVENTIONS §d).
import { getFirstEmailByContactId, getTranscriptSegmentsForMeetings } from "@/lib/data/meetings";
import { getActionItemsForMeetings } from "@/lib/data/action-items";
import { getAttachmentsForMeetings } from "@/lib/data/attachments";
import type { Meeting, ActionItemWithContacts, MeetingActionsMap, InteractionWithContact, TranscriptSegment } from "@/lib/types";
import { Plus, Calendar, Search, Pencil, CheckSquare, Trash2, Check, RotateCcw, MessageSquare, Paperclip, AlertCircle } from "lucide-react";
import Link from "next/link";
import { DatePicker } from "@/components/ui/date-picker";
import { ContactPicker } from "@/components/ui/contact-picker";
import TranscriptViewer from "@/components/transcript-viewer";
import SpeakerResolver, { type SpeakerCandidate } from "@/components/speaker-resolver";
import { TranscriptActionSuggestions } from "@/components/meetings/transcript-action-suggestions";
import { useGmailConnection } from "@/hooks/use-gmail-connection";
import { useQuickCapture } from "@/components/quick-capture-context";

import { inputClasses } from "@/lib/form-styles";
import { getRsvpDisplay, conversationTypeLabel } from "@/lib/constants";
import { withToastOnError } from "@/lib/with-toast-on-error";
import { dueDateKey, formatDueDate, isDueDateOverdue } from "@/lib/due-date";
import { formatWallClock } from "@/lib/calendar-day";
import { LoadErrorState, LoadErrorBanner } from "@/components/ui/load-error-state";
import { useConfirm } from "@/components/ui/confirm-dialog";

export default function MeetingsPage() {
  const { user } = useAuth();
  const { success: toastSuccess, error: toastError } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const { calendarConnected, loading: connectionLoading } = useGmailConnection();
  const { open: openConversationModal, openEdit: openEditModal } = useQuickCapture();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  // SpeakerCandidate, not SimpleContact: the AI speaker matcher also reads
  // `industry`, and a SimpleContact[] annotation would erase it here (CAR-158).
  //
  // Loaded on demand, never on mount (CAR-229): this is ~2,000 rows dragging
  // every joined email, phone, company, school and tag, and it was the slowest
  // request on the page for two widgets most visits never open.
  const [allContacts, setAllContacts] = useState<SpeakerCandidate[]>([]);
  const [contactsLoaded, setContactsLoaded] = useState(false);
  const contactsRequested = useRef(false);
  /**
   * Contacts named by a row on screen but not (yet) in the full list: the
   * action items an edit form opens over already carry their assigned contacts,
   * so the picker renders its chips immediately instead of blanking for as long
   * as the full fetch takes. Merged UNDER the real list, never over it.
   */
  const [namedContacts, setNamedContacts] = useState<{ id: number; name: string }[]>([]);
  /** contact id → first email, for RSVP badge matching. See loadMeetings. */
  const [attendeeEmails, setAttendeeEmails] = useState<Map<number, string>>(new Map());
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
  const [meetingCalendarMap, setMeetingCalendarMap] = useState<Record<number, { google_event_id: string; attendees: CalendarAttendee[] }>>({});

  // Search
  const [searchQuery, setSearchQuery] = useState("");

  // Transcript segments for timeline display
  const [meetingSegments, setMeetingSegments] = useState<Record<number, TranscriptSegment[]>>({});
  const [showSpeakerResolver, setShowSpeakerResolver] = useState<number | null>(null);

  /**
   * Fetch the full contact list, once, the first time a widget that genuinely
   * needs all of it opens: the action-item ContactPicker and the speaker
   * resolver. Idempotent via a ref rather than `contactsLoaded`, so two opens in
   * the same tick can't both fire it; the ref is released on failure so the next
   * open retries.
   */
  const ensureAllContacts = useCallback(async () => {
    if (!user || contactsRequested.current) return;
    contactsRequested.current = true;
    try {
      const data = await getContacts(user.id);
      const contacts = data.map((c) => {
        const emails = (c.contact_emails || []).map((e) => e.email).filter((e): e is string => Boolean(e));
        return {
          id: c.id,
          name: c.name,
          email: emails[0] || undefined,
          photo_url: c.photo_url,
          // Feeds the AI speaker-matching prompt (SpeakerResolver).
          industry: c.industry,
        };
      });
      setAllContacts(contacts);
      setContactsLoaded(true);
    } catch (e) {
      contactsRequested.current = false;
      console.error("Error loading contacts:", e);
    }
  }, [user]);

  /**
   * What the pickers search: the full list once loaded, plus on-screen names.
   * Deduped by id — `namedContacts` is appended to on every edit-form open, so
   * reopening the same action item would otherwise render duplicate options.
   */
  const pickerContacts = useMemo(() => {
    const seen = new Set(allContacts.map((c) => c.id));
    const extra: { id: number; name: string }[] = [];
    for (const c of namedContacts) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      extra.push(c);
    }
    return [...allContacts, ...extra];
  }, [allContacts, namedContacts]);

  const loadInteractions = useCallback(async () => {
    if (!user) return;
    try {
      const data = await getAllInteractions(user.id);
      setAllInteractions(data as unknown as InteractionWithContact[]);
    } catch (e) { console.error("Error loading interactions:", e); }
  }, [user]);

  const loadMeetings = useCallback(async () => {
    // Clear the spinner on the guard path too, so a retry clicked after auth
    // is lost can't strand `loading` at true forever (CAR-154 review).
    if (!user) { setLoading(false); return; }
    setLoadError(false);
    try {
      const data = await getMeetings(user.id);
      setMeetings(data);

      // Load calendar events for meetings that have a linked calendar_event_id
      const calEventIds = data
        .map(m => m.calendar_event_id)
        .filter((id): id is string => Boolean(id));
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
            const calMap: Record<number, { google_event_id: string; attendees: CalendarAttendee[] }> = {};
            for (const m of data) {
              const ce = calEvents.find((c) => c.google_event_id === m.calendar_event_id);
              if (ce) calMap[m.id] = {
                google_event_id: ce.google_event_id,
                attendees: parseCalendarAttendees(ce.attendees),
              };
            }
            setMeetingCalendarMap(calMap);
          }
        } catch {
          // Calendar RSVP badges are enrichment; the meetings list already
          // rendered, so a failed lookup just leaves the badges off.
        }
      }
      // Everything the timeline rows need, in FOUR reads for the whole list.
      // Three of them replace a per-meeting fetch: getMeetings returns up to
      // 200 rows, so that fan-out was up to 600 concurrent requests (CAR-229).
      // The fourth resolves RSVP badges, which compare a calendar attendee's
      // address against the contact's first email — that used to come out of
      // the whole contact list, and is now keyed by the attendees of
      // calendar-linked meetings, the only ones that can render a badge.
      //
      // allSettled so one failing read leaves the others on screen, which is
      // the resilience the per-meeting try/catch used to give.
      const meetingIds = data.map((m) => m.id);
      const [actionsRes, attRes, segRes, emailRes] = await Promise.allSettled([
        getActionItemsForMeetings(meetingIds),
        getAttachmentsForMeetings(meetingIds),
        // Only load segments for meetings that have parsed transcripts
        getTranscriptSegmentsForMeetings(data.filter((m) => m.transcript_parsed).map((m) => m.id)),
        getFirstEmailByContactId(user.id, [...new Set(
          data.filter((m) => m.calendar_event_id)
            .flatMap((m) => m.meeting_contacts.map((mc) => mc.contact_id)),
        )]),
      ]);
      setMeetingActions(actionsRes.status === "fulfilled" ? actionsRes.value : {});
      setMeetingAttachments(attRes.status === "fulfilled" ? attRes.value : {});
      setMeetingSegments(segRes.status === "fulfilled" ? segRes.value : {});
      // Badges are enrichment over a list that has already rendered, so a
      // failure here just leaves them off — same as the calendar_events read.
      if (emailRes.status === "fulfilled") setAttendeeEmails(emailRes.value);
      for (const r of [actionsRes, attRes, segRes, emailRes]) {
        if (r.status === "rejected") console.error("Error loading meeting details:", r.reason);
      }
    }
    catch (e) { console.error("Error loading meetings:", e); setLoadError(true); }
    finally { setLoading(false); }
  }, [user]);

  // Each loader catches its own failures (console.error, and setLoadError on
  // the meetings loader), so these are deliberately fire-and-forget.
  useEffect(() => {
    if (user) {
      void loadMeetings();
      void loadInteractions();
    }
  }, [user, loadMeetings, loadInteractions]);

  // Refresh when a conversation is logged via the unified modal
  useEffect(() => {
    const handler = () => {
      void loadMeetings();
      void loadInteractions();
    };
    return onUiEvent(UI_EVENTS.conversationLogged, handler);
  }, [loadMeetings, loadInteractions]);

  const reloadMeetingActions = async (meetingId: number) => {
    try {
      const items = await getActionItemsForMeeting(meetingId);
      setMeetingActions(prev => ({ ...prev, [meetingId]: items as ActionItemWithContacts[] }));
    } catch {
      // Best-effort refresh after a mutation; the write already succeeded and a
      // stale list self-heals on the next reload.
    }
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
    } catch {
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
    } catch {
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
    } catch {
      toastError("Failed to delete attachment");
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <div className="flex items-center gap-4 text-muted-foreground">
            <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary border-t-transparent" />
            <span className="text-base">Loading meetings…</span>
          </div>
        </div>
      </div>
    );
  }

  if (loadError && meetings.length === 0 && allInteractions.length === 0) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <LoadErrorState
            message="We could not load your activity"
            onRetry={() => { setLoading(true); void loadMeetings(); void loadInteractions(); }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        {/* Header */}
        <div className="flex justify-between items-center mb-10">
          <div>
            <h1 className="text-[28px] leading-9 font-normal text-foreground">Activity</h1>
            <p className="text-base text-muted-foreground mt-1">
              {meetings.length} {meetings.length === 1 ? "meeting" : "meetings"} · {allInteractions.length} {allInteractions.length === 1 ? "interaction" : "interactions"}
            </p>
          </div>
          <div className="flex gap-2.5">
            <Button onClick={() => openConversationModal()}>
              <Plus className="h-5 w-5" /> Log conversation
            </Button>
          </div>
        </div>

        {/* Calendar not connected banner */}
        {!calendarConnected && !loading && !connectionLoading && (
          <div className="flex gap-4 p-4 rounded-xl bg-tertiary-container border border-outline-variant mb-6">
            <AlertCircle className="h-6 w-6 text-on-tertiary-container shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-base font-medium text-on-tertiary-container">
                Google Calendar not connected
              </p>
              <p className="text-sm text-on-tertiary-container/80 mt-0.5">
                Connect your Google Calendar to add meetings to your calendar and generate Google Meet links.{" "}
                <Link href="/settings?tab=integrations" className="underline font-medium">
                  Go to Integrations
                </Link>
              </p>
            </div>
          </div>
        )}

        {/* Partial failure: the meetings loader failed but interactions (an
            independent loader) or prior data are on screen. Flag it inline
            instead of silently masking the failure (CAR-154 review F4). */}
        {loadError && (meetings.length > 0 || allInteractions.length > 0) && (
          <LoadErrorBanner
            message="Some of your activity could not be loaded."
            onRetry={() => { void loadMeetings(); void loadInteractions(); }}
            className="mb-6"
          />
        )}

        {/* Search bar */}
        <div className="relative mb-7">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search meetings and interactions…"
            className="w-full h-12 pl-11 pr-5 bg-surface-container-low text-foreground rounded-full border border-outline-variant placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:border-2 transition-colors text-base"
          />
        </div>


        {/* Empty state */}
        {meetings.length === 0 && allInteractions.length === 0 && (
          <Card variant="outlined" className="text-center py-16">
            <CardContent>
              <Calendar className="mx-auto h-14 w-14 text-muted-foreground/40 mb-5" />
              <p className="text-lg text-foreground mb-1">No activity yet</p>
              <p className="text-base text-muted-foreground mb-2">
                Record coffee chats, calls, and casual interactions to build a history with your contacts.
              </p>
              <p className="text-sm text-muted-foreground mb-7">
                Meetings support notes, transcripts, and action items. Interactions are lighter: just a date and summary.
              </p>
              <div className="flex justify-center gap-2.5">
                <Button onClick={() => openConversationModal()}>
                  <Plus className="h-5 w-5" /> Log conversation
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Unified timeline: meetings + interactions sorted by date desc */}
        <div className="space-y-4">
          {(() => {
            const q = searchQuery.toLowerCase().trim();
            const matchesMeeting = (m: Meeting) => {
              if (!q) return true;
              const title = m.title || "";
              const names = m.meeting_contacts.map(mc => mc.contacts?.name || "").join(" ");
              return (
                title.toLowerCase().includes(q) ||
                conversationTypeLabel(m.meeting_type, m.meeting_type_detail)?.toLowerCase().includes(q) ||
                (m.notes || "").toLowerCase().includes(q) ||
                (m.private_notes || "").toLowerCase().includes(q) ||
                names.toLowerCase().includes(q)
              );
            };
            const matchesInteraction = (i: InteractionWithContact) => {
              if (!q) return true;
              return (
                (conversationTypeLabel(i.interaction_type, i.interaction_type_detail) || "").toLowerCase().includes(q) ||
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
                <div className="text-center py-16 text-muted-foreground text-base">
                  No results for &ldquo;{searchQuery}&rdquo;
                </div>
              );
            }

            return timeline.map((item) => item.kind === "interaction" ? (
              <div key={`i-${(item.data as InteractionWithContact).id}`} className="rounded-[16px] border border-outline-variant/60 bg-white hover:border-outline-variant hover:shadow-sm transition-all duration-200">
                <div className="p-6">
                  <div className="flex items-center justify-between gap-5">
                    <div className="flex items-center gap-5 min-w-0">
                      <div className="w-16 h-16 rounded-full bg-primary-container flex items-center justify-center shrink-0">
                        <MessageSquare className="h-7 w-7 text-on-primary-container" />
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-lg font-medium text-foreground">{conversationTypeLabel((item.data as InteractionWithContact).interaction_type, (item.data as InteractionWithContact).interaction_type_detail) || "Interaction"}</h3>
                        <p className="text-base text-muted-foreground">
                          {new Date((item.data as InteractionWithContact).interaction_date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={async () => {
                        if (!(await confirm({
                          message: "Delete this interaction?",
                          confirmLabel: "Delete",
                          destructive: true,
                        }))) return;
                        await withToastOnError(async () => {
                          await deleteInteraction((item.data as InteractionWithContact).id);
                          await loadInteractions();
                        }, toastError, "Couldn't delete that interaction. Please try again.");
                      }}
                      className="p-2 rounded-full text-muted-foreground hover:text-destructive cursor-pointer transition-colors"
                    >
                      <Trash2 className="h-5 w-5" />
                    </button>
                  </div>
                  <div className="mt-3 ml-[60px]">
                    <span className="inline-flex items-center h-8 px-4 rounded-full bg-primary-container text-sm text-on-primary-container font-medium">
                      {(item.data as InteractionWithContact).contacts?.name}
                    </span>
                  </div>
                  {(item.data as InteractionWithContact).summary && (
                    <div className="mt-4 ml-[60px]">
                      <p className="text-base text-foreground leading-relaxed whitespace-pre-wrap">{(item.data as InteractionWithContact).summary}</p>
                    </div>
                  )}
                </div>
              </div>
            ) : (() => {
              const meeting = item.data as Meeting;
              return (
            <div key={`m-${meeting.id}`} className="rounded-[16px] border border-outline-variant/60 bg-white hover:border-outline-variant hover:shadow-sm transition-all duration-200">
              <div className="p-6">
                <div className="flex items-center justify-between gap-5">
                  <div className="flex items-center gap-5 min-w-0">
                    <div className="w-16 h-16 rounded-full bg-secondary-container flex items-center justify-center shrink-0">
                      <Calendar className="h-7 w-7 text-on-secondary-container" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-lg font-medium text-foreground">{meeting.title || conversationTypeLabel(meeting.meeting_type, meeting.meeting_type_detail) || "Meeting"}</h3>
                      <p className="text-base text-muted-foreground">
                        {formatWallClock(meeting.meeting_date, { weekday: "short", month: "short", day: "numeric", year: "numeric" }, "en-US")}
                        {" · "}
                        {formatWallClock(meeting.meeting_date, { hour: "numeric", minute: "2-digit" }, "en-US")}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => openEditModal(meeting, meetingActions[meeting.id] || [])} className="p-2 rounded-full text-muted-foreground hover:text-primary cursor-pointer transition-colors">
                      <Pencil className="h-5 w-5" />
                    </button>
                    <button
                      onClick={async () => {
                        // The action items SURVIVE the meeting:
                        // follow_up_action_items.meeting_id is ON DELETE SET
                        // NULL, so they are unlinked rather than removed. The
                        // old copy said only "cannot be undone", which left the
                        // user expecting the opposite (CAR-249).
                        const orphanCount = (meetingActions[meeting.id] || []).length;
                        if (!(await confirm({
                          title: "Delete this meeting?",
                          message: orphanCount > 0
                            ? `This cannot be undone. ${orphanCount} action item${orphanCount === 1 ? "" : "s"} from this meeting will be kept, no longer linked to it.`
                            : "This cannot be undone.",
                          confirmLabel: "Delete",
                          destructive: true,
                        }))) return;
                        try {
                          await deleteMeeting(meeting.id);
                          await loadMeetings();
                          toastSuccess("Meeting deleted");
                        } catch {
                          toastError("Failed to delete meeting");
                        }
                      }}
                      className="p-2 rounded-full text-muted-foreground hover:text-destructive cursor-pointer transition-colors"
                    >
                      <Trash2 className="h-5 w-5" />
                    </button>
                  </div>
                </div>

                {meeting.meeting_contacts.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-4 ml-[60px]">
                    {meeting.meeting_contacts.map((mc: Meeting["meeting_contacts"][0]) => {
                      const calEvent = meetingCalendarMap[meeting.id];
                      const contactEmail = attendeeEmails.get(mc.contact_id);
                      const rsvp = calEvent && contactEmail
                        ? calEvent.attendees.find((a) => a.email === contactEmail)?.responseStatus
                        : undefined;
                      const rsvpInfo = rsvp ? getRsvpDisplay(rsvp) : null;
                      return (
                        <span key={mc.contact_id} className="inline-flex items-center h-8 px-4 rounded-full bg-secondary-container text-sm text-on-secondary-container font-medium">
                          {mc.contacts.name}
                          {rsvpInfo && rsvp !== "needsAction" && <span className={`ml-1 font-bold ${rsvpInfo.className}`}>{rsvpInfo.label}</span>}
                        </span>
                      );
                    })}
                    {meetingCalendarMap[meeting.id] && (
                      <span className="inline-flex items-center h-8 px-3 rounded-full bg-primary/10 text-xs text-primary font-medium gap-1.5">
                        <Calendar className="h-3.5 w-3.5" />
                        On calendar
                      </span>
                    )}
                  </div>
                )}

                {meeting.private_notes && (
                  <div className="mt-4 ml-[60px]">
                    <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-2">Private reminders</h4>
                    <p className="text-base text-foreground leading-relaxed whitespace-pre-wrap">{meeting.private_notes}</p>
                  </div>
                )}

                {meeting.notes && (
                  <div className="mt-4 ml-[60px]">
                    <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-2">Notes</h4>
                    <p className="text-base text-foreground leading-relaxed whitespace-pre-wrap">{meeting.notes}</p>
                  </div>
                )}

                {(meeting.transcript || meetingSegments[meeting.id]?.length > 0) && (
                  <div className="mt-4 ml-[60px]">
                    <div className="flex items-center justify-between mb-1.5">
                      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Transcript</h4>
                      {meetingSegments[meeting.id]?.length > 0 && (
                        <button
                          type="button"
                          className="text-sm text-primary hover:underline cursor-pointer"
                          onClick={() => {
                            // The resolver searches every contact, so this click
                            // is what pays for the list (CAR-229).
                            if (showSpeakerResolver !== meeting.id) void ensureAllContacts();
                            setShowSpeakerResolver(showSpeakerResolver === meeting.id ? null : meeting.id);
                          }}
                        >
                          {showSpeakerResolver === meeting.id ? "Hide" : "Match speakers"}
                        </button>
                      )}
                    </div>
                    {showSpeakerResolver === meeting.id && meetingSegments[meeting.id] && (
                      <div className="mb-3">
                        <SpeakerResolver
                          segments={meetingSegments[meeting.id]}
                          meetingContacts={meeting.meeting_contacts.map(mc => ({ id: mc.contacts.id, name: mc.contacts.name, industry: mc.contacts.industry }))}
                          // undefined, not [], until the fetch lands: the
                          // resolver's own fallback is "use the meeting's
                          // attendees", and an empty array would suppress it and
                          // hand the AI matcher no candidates at all.
                          allContacts={contactsLoaded ? allContacts : undefined}
                          meetingTitle={meeting.title || undefined}
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
                  <div className="mt-5 ml-[60px]">
                    <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-2">Action items</h4>
                    <div className="space-y-2">
                      {meetingActions[meeting.id].map((action) => (
                        cardEditActionId === action.id ? (
                          <div key={action.id} className="p-4 rounded-[8px] bg-surface-container space-y-2.5">
                            <input type="text" value={cardEditTitle} onChange={(e) => setCardEditTitle(e.target.value)} className={`${inputClasses} !h-11 text-base`} placeholder="Title" />
                            <textarea value={cardEditDescription} onChange={(e) => setCardEditDescription(e.target.value)} className={`${inputClasses} !h-auto py-2.5 text-base`} rows={2} placeholder="Description (optional)" />
                            <ContactPicker allContacts={pickerContacts} selectedIds={cardEditContactIds} onChange={setCardEditContactIds} />
                            <DatePicker value={cardEditDueDate} onChange={setCardEditDueDate} placeholder="No due date" />
                            <div className="flex justify-end gap-2">
                              <Button type="button" variant="text" size="sm" onClick={() => setCardEditActionId(null)}>Cancel</Button>
                              <Button type="button" size="sm" onClick={() => withToastOnError(async () => {
                                await updateActionItem(action.id, { title: cardEditTitle.trim(), description: cardEditDescription.trim() || null, due_at: cardEditDueDate || null });
                                await replaceContactsForActionItem(action.id, cardEditContactIds);
                                await reloadMeetingActions(meeting.id);
                                setCardEditActionId(null);
                              }, toastError, "Couldn't save that action item. Please try again.")}>Save</Button>
                            </div>
                          </div>
                        ) : (
                          <div key={action.id} className="flex items-center gap-2.5 text-base group">
                            <CheckSquare className={`h-4 w-4 shrink-0 ${action.is_completed ? "text-primary" : "text-muted-foreground"}`} />
                            <span className={`flex-1 min-w-0 truncate ${action.is_completed ? "line-through text-muted-foreground" : "text-foreground"}`}>{action.title}</span>
                            <span className="text-sm text-muted-foreground shrink-0">{(action.action_item_contacts?.map(ac => ac.contacts?.name).filter(Boolean).join(", ")) || action.contacts?.name || ""}</span>
                            {action.due_at && (
                              <span className={`text-sm shrink-0 ${isDueDateOverdue(action.due_at) && !action.is_completed ? "text-destructive font-medium" : "text-muted-foreground"}`}>
                                {formatDueDate(action.due_at, { month: "short", day: "numeric" }, "en-US")}
                              </span>
                            )}
                            <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button type="button" onClick={() => {
                                // The picker searches every contact, so opening
                                // the form is what pays for the list. Its already
                                // assigned contacts come embedded on the action
                                // item, so the chips render now rather than after
                                // the fetch (CAR-229).
                                void ensureAllContacts();
                                setNamedContacts(prev => [
                                  ...prev,
                                  ...(action.action_item_contacts ?? []).map(ac => ac.contacts).filter((c): c is { id: number; name: string } => c != null),
                                  ...(action.contacts ? [action.contacts] : []),
                                ]);
                                setCardEditActionId(action.id); setCardEditTitle(action.title); setCardEditDescription(action.description || ""); setCardEditDueDate(dueDateKey(action.due_at) ?? ""); setCardEditContactIds(action.action_item_contacts?.map(ac => ac.contact_id) || (action.contacts ? [action.contacts.id] : [])); }} className="p-1.5 rounded-full text-muted-foreground hover:text-foreground cursor-pointer" title="Edit">
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              {action.is_completed ? (
                                <button type="button" onClick={() => withToastOnError(async () => { await updateActionItem(action.id, { is_completed: false, completed_at: null }); await reloadMeetingActions(meeting.id); }, toastError, "Couldn't restore that action item. Please try again.")} className="p-1.5 rounded-full text-muted-foreground hover:text-primary cursor-pointer" title="Restore">
                                  <RotateCcw className="h-3.5 w-3.5" />
                                </button>
                              ) : (
                                <button type="button" onClick={() => withToastOnError(async () => { await updateActionItem(action.id, { is_completed: true, completed_at: new Date().toISOString() }); await reloadMeetingActions(meeting.id); }, toastError, "Couldn't update that action item. Please try again.")} className="p-1.5 rounded-full text-muted-foreground hover:text-primary cursor-pointer" title="Mark done">
                                  <Check className="h-3.5 w-3.5" />
                                </button>
                              )}
                              <button type="button" onClick={async () => { if (!(await confirm({ message: "Delete this action item?", confirmLabel: "Delete", destructive: true }))) return; await withToastOnError(async () => { await deleteActionItem(action.id); await reloadMeetingActions(meeting.id); }, toastError, "Couldn't delete that action item. Please try again."); }} className="p-1.5 rounded-full text-muted-foreground hover:text-destructive cursor-pointer" title="Delete">
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        )
                      ))}
                    </div>
                  </div>
                )}

                {/* Attachments */}
                <div className="mt-5 ml-[60px]">
                  {meetingAttachments[meeting.id] && meetingAttachments[meeting.id].length > 0 && (
                    <div className="mb-2.5">
                      <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-2">Attachments</h4>
                      <div className="space-y-1.5">
                        {meetingAttachments[meeting.id].map((att) => (
                          <div key={att.id} className="flex items-center gap-2.5 text-base group">
                            <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <button
                              type="button"
                              className="text-primary hover:underline truncate max-w-[200px] cursor-pointer text-left"
                              onClick={() => handleMeetingAttachmentDownload(att.object_path, att.file_name)}
                            >
                              {att.file_name}
                            </button>
                            {att.file_size_bytes && (
                              <span className="text-sm text-muted-foreground">
                                {att.file_size_bytes < 1024 ? `${att.file_size_bytes} B`
                                  : att.file_size_bytes < 1048576 ? `${(att.file_size_bytes / 1024).toFixed(0)} KB`
                                  : `${(att.file_size_bytes / 1048576).toFixed(1)} MB`}
                              </span>
                            )}
                            <button
                              type="button"
                              className="ml-auto opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all cursor-pointer"
                              onClick={() => handleMeetingAttachmentDelete(meeting.id, att.id, att.object_path)}
                              title="Delete attachment"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <label className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:text-primary/80 cursor-pointer transition-colors">
                    <Paperclip className="h-4 w-4" />
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

      {confirmDialog}
    </div>
  );
}
