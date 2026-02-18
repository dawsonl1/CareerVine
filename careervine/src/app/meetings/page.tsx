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

import { useState, useEffect } from "react";
import { useAuth } from "@/components/auth-provider";
import Navigation from "@/components/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getMeetings, createMeeting, updateMeeting, getContacts, addContactsToMeeting, replaceContactsForMeeting, createActionItem, getActionItemsForMeeting, updateActionItem, deleteActionItem, replaceContactsForActionItem, createInteraction, getAllInteractions, deleteInteraction, uploadAttachment, addAttachmentToMeeting, getAttachmentsForMeeting, getAttachmentUrl, deleteAttachment } from "@/lib/queries";
import type { Meeting, SimpleContact, ActionItemWithContacts, MeetingActionsMap, InteractionWithContact } from "@/lib/types";
import { Plus, Calendar, X, Search, Pencil, CheckSquare, Trash2, Check, RotateCcw, MessageSquare, Paperclip } from "lucide-react";
import { DatePicker } from "@/components/ui/date-picker";
import { TimePicker } from "@/components/ui/time-picker";
import { Select } from "@/components/ui/select";
import { ContactPicker } from "@/components/ui/contact-picker";

const emptyForm = { meeting_date: "", meeting_time: "", meeting_type: "", notes: "", transcript: "" };
const inputClasses =
  "w-full h-14 px-4 bg-surface-container-low text-foreground rounded-[4px] border border-outline placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:border-2 transition-colors text-sm";
const labelClasses = "block text-xs font-medium text-muted-foreground mb-1.5";

export default function MeetingsPage() {
  const { user } = useAuth();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState(emptyForm);
  const [allContacts, setAllContacts] = useState<SimpleContact[]>([]);
  const [selectedContactIds, setSelectedContactIds] = useState<number[]>([]);
  const [contactSearch, setContactSearch] = useState("");
  const [editingMeeting, setEditingMeeting] = useState<Meeting | null>(null);
  const [pendingActions, setPendingActions] = useState<{ title: string; contactIds: number[]; dueDate: string; description: string; meetingId: number | null }[]>([]);
  const [showActionSub, setShowActionSub] = useState(false);
  const [actionTitle, setActionTitle] = useState("");
  const [actionDescription, setActionDescription] = useState("");
  const [actionContactIds, setActionContactIds] = useState<number[]>([]);
  const [actionDueDate, setActionDueDate] = useState("");
  const [existingActions, setExistingActions] = useState<(ActionItemWithContacts & { contact_id: number })[]>([]);
  const [editingActionId, setEditingActionId] = useState<number | null>(null);
  const [editActionTitle, setEditActionTitle] = useState("");
  const [editActionDescription, setEditActionDescription] = useState("");
  const [editActionDueDate, setEditActionDueDate] = useState("");
  const [editActionContactIds, setEditActionContactIds] = useState<number[]>([]);
  const [meetingActions, setMeetingActions] = useState<MeetingActionsMap>({});
  const [cardEditActionId, setCardEditActionId] = useState<number | null>(null);
  const [cardEditTitle, setCardEditTitle] = useState("");
  const [cardEditDescription, setCardEditDescription] = useState("");
  const [cardEditDueDate, setCardEditDueDate] = useState("");
  const [cardEditContactIds, setCardEditContactIds] = useState<number[]>([]);

  // Attachments per meeting
  const [meetingAttachments, setMeetingAttachments] = useState<Record<number, { id: number; file_name: string; content_type: string | null; file_size_bytes: number | null; object_path: string }[]>>({});
  const [attachmentUploading, setAttachmentUploading] = useState<number | null>(null);

  // Interactions
  const [allInteractions, setAllInteractions] = useState<InteractionWithContact[]>([]);
  const [showInteractionModal, setShowInteractionModal] = useState(false);
  const [interactionContactId, setInteractionContactId] = useState<number | null>(null);
  const [interactionForm, setInteractionForm] = useState({ interaction_date: "", interaction_type: "", summary: "" });
  const [interactionSaving, setInteractionSaving] = useState(false);

  // Calendar integration
  const [calendarConnected, setCalendarConnected] = useState(false);
  const [addToCalendar, setAddToCalendar] = useState(false);
  const [includeMeetLink, setIncludeMeetLink] = useState(true);
  const [meetingDuration, setMeetingDuration] = useState(60);
  const [meetingCalendarMap, setMeetingCalendarMap] = useState<Record<number, { google_event_id: string; attendees: Array<{ email: string; name: string; responseStatus: string }> }>>({});

  useEffect(() => {
    if (user) {
      loadMeetings();
      loadContacts();
      loadInteractions();
      checkCalendarConnection();
    }
  }, [user]);

  const checkCalendarConnection = async () => {
    try {
      const res = await fetch("/api/gmail/connection");
      const data = await res.json();
      if (data.connection?.calendar_scopes_granted) {
        setCalendarConnected(true);
        setAddToCalendar(true);
      }
    } catch {}
  };

  const loadContacts = async () => {
    if (!user) return;
    try {
      const data = await getContacts(user.id);
      setAllContacts((data as any[]).map((c) => ({
        id: c.id,
        name: c.name,
        email: c.contact_emails?.[0]?.email || undefined,
      })));
    } catch (e) { console.error("Error loading contacts:", e); }
  };

  const loadInteractions = async () => {
    if (!user) return;
    try {
      const data = await getAllInteractions(user.id);
      setAllInteractions(data as unknown as InteractionWithContact[]);
    } catch (e) { console.error("Error loading interactions:", e); }
  };

  const loadMeetings = async () => {
    if (!user) return;
    try {
      const data = await getMeetings(user.id);
      setMeetings(data as unknown as Meeting[]);

      // Load calendar events for meetings that have a linked calendar_event_id
      const calEventIds = (data as any[]).map(m => m.calendar_event_id).filter(Boolean);
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
            for (const m of data as any[]) {
              const ce = calEvents.find((c: any) => c.google_event_id === m.calendar_event_id);
              if (ce) calMap[m.id] = { google_event_id: ce.google_event_id, attendees: ce.attendees || [] };
            }
            setMeetingCalendarMap(calMap);
          }
        } catch {}
      }
      // Load action items and attachments for each meeting
      const actionsMap: MeetingActionsMap = {};
      const attMap: typeof meetingAttachments = {};
      await Promise.all(data.map(async (m) => {
        try {
          const [items, atts] = await Promise.all([
            getActionItemsForMeeting(m.id),
            getAttachmentsForMeeting(m.id),
          ]);
          if (items.length > 0) actionsMap[m.id] = items as ActionItemWithContacts[];
          if (atts.length > 0) attMap[m.id] = atts as typeof meetingAttachments[number];
        } catch {}
      }));
      setMeetingActions(actionsMap);
      setMeetingAttachments(attMap);
    }
    catch (e) { console.error("Error loading meetings:", e); }
    finally { setLoading(false); }
  };

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
      console.error("Error uploading attachment:", err);
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
      console.error("Error downloading attachment:", err);
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
      console.error("Error deleting attachment:", err);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    try {
      const dateTime = formData.meeting_date && formData.meeting_time
        ? `${formData.meeting_date}T${formData.meeting_time}`
        : formData.meeting_date;

      let meetingId: number;
      if (editingMeeting) {
        await updateMeeting(editingMeeting.id, {
          meeting_date: dateTime,
          meeting_type: formData.meeting_type,
          notes: formData.notes || null,
          transcript: formData.transcript || null,
        });
        await replaceContactsForMeeting(editingMeeting.id, selectedContactIds);
        meetingId = editingMeeting.id;

        // Sync update to linked Google Calendar event
        if ((editingMeeting as any).calendar_event_id) {
          try {
            const startTime = new Date(dateTime).toISOString();
            const endTime = new Date(new Date(dateTime).getTime() + meetingDuration * 60000).toISOString();
            await fetch(`/api/calendar/events/${(editingMeeting as any).calendar_event_id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                summary: formData.meeting_type
                  ? `${formData.meeting_type.charAt(0).toUpperCase() + formData.meeting_type.slice(1).replace("-", " ")} with ${selectedContactIds.map(id => allContacts.find(c => c.id === id)?.name).filter(Boolean).join(", ") || "Contact"}`
                  : "Meeting",
                description: formData.notes || undefined,
                startTime,
                endTime,
              }),
            });
          } catch (err) {
            console.error("Failed to update calendar event:", err);
          }
        }
      } else {
        const created = await createMeeting({
          user_id: user.id,
          meeting_date: dateTime,
          meeting_type: formData.meeting_type,
          notes: formData.notes || null,
          transcript: formData.transcript || null,
        });
        if (selectedContactIds.length > 0) {
          await addContactsToMeeting(created.id, selectedContactIds);
        }
        meetingId = created.id;

        // Create Google Calendar event for future meetings
        const meetingDateTime = new Date(dateTime);
        const isFuture = meetingDateTime > new Date();
        if (addToCalendar && calendarConnected && isFuture && formData.meeting_time) {
          try {
            const attendeeEmails = selectedContactIds
              .map(id => allContacts.find(c => c.id === id))
              .filter(Boolean)
              .map(c => {
                const contact = c as SimpleContact & { email?: string };
                return contact.email || null;
              })
              .filter(Boolean) as string[];

            const startTime = new Date(dateTime).toISOString();
            const endTime = new Date(new Date(dateTime).getTime() + meetingDuration * 60000).toISOString();

            await fetch("/api/calendar/create-event", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                summary: formData.meeting_type
                  ? `${formData.meeting_type.charAt(0).toUpperCase() + formData.meeting_type.slice(1).replace("-", " ")} with ${selectedContactIds.map(id => allContacts.find(c => c.id === id)?.name).filter(Boolean).join(", ") || "Contact"}`
                  : "Meeting",
                description: formData.notes || undefined,
                startTime,
                endTime,
                attendeeEmails,
                conferenceType: includeMeetLink ? "meet" : "none",
                meetingId: created.id,
              }),
            });
          } catch (err) {
            console.error("Failed to create calendar event:", err);
          }
        }
      }
      // Create any pending action items, linking to the meeting
      for (const action of pendingActions) {
        if (action.contactIds.length > 0) {
          await createActionItem({
            user_id: user.id,
            contact_id: action.contactIds[0],
            meeting_id: meetingId,
            title: action.title,
            description: action.description || null,
            due_at: action.dueDate || null,
            is_completed: false,
            created_at: new Date().toISOString(),
            completed_at: null,
          }, action.contactIds);
        }
      }
      await loadMeetings();
      closeForm();
    } catch (e) { console.error("Error saving meeting:", e); }
  };

  const handleEdit = async (meeting: Meeting) => {
    const d = new Date(meeting.meeting_date);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const timeStr = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    setEditingMeeting(meeting);
    setFormData({
      meeting_date: dateStr,
      meeting_time: timeStr,
      meeting_type: meeting.meeting_type,
      notes: meeting.notes || "",
      transcript: meeting.transcript || "",
    });
    setSelectedContactIds(meeting.meeting_contacts.map((mc) => mc.contact_id));
    setContactSearch("");
    // Load existing action items for this meeting
    try {
      const actions = await getActionItemsForMeeting(meeting.id);
      setExistingActions(actions as typeof existingActions);
    } catch (e) { console.error("Error loading meeting action items:", e); }
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingMeeting(null);
    setFormData(emptyForm);
    setSelectedContactIds([]);
    setContactSearch("");
    setPendingActions([]);
    setExistingActions([]);
    setActionTitle("");
    setActionContactIds([]);
    setActionDueDate("");
    setAddToCalendar(calendarConnected);
    setIncludeMeetLink(true);
    setMeetingDuration(60);
  };

  const addPendingAction = () => {
    if (!actionTitle.trim() || actionContactIds.length === 0) return;
    setPendingActions([...pendingActions, { title: actionTitle.trim(), contactIds: actionContactIds, dueDate: actionDueDate, description: actionDescription.trim(), meetingId: null }]);
    setActionTitle("");
    setActionDescription("");
    setActionContactIds([]);
    setActionDueDate("");
    setShowActionSub(false);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
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
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-[28px] leading-9 font-normal text-foreground">Activity</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {meetings.length} {meetings.length === 1 ? "meeting" : "meetings"} · {allInteractions.length} {allInteractions.length === 1 ? "interaction" : "interactions"}
            </p>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => setShowForm(true)}>
              <Plus className="h-[18px] w-[18px]" /> Add meeting
            </Button>
            <Button variant="tonal" onClick={() => {
              setInteractionContactId(null);
              setInteractionForm({ interaction_date: new Date().toISOString().split("T")[0], interaction_type: "", summary: "" });
              setShowInteractionModal(true);
            }}>
              <MessageSquare className="h-[18px] w-[18px]" /> Add interaction
            </Button>
          </div>
        </div>

        {/* Modal */}
        {showForm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/32" onClick={() => { const hasContent = formData.meeting_date || formData.meeting_time || formData.meeting_type || formData.notes || formData.transcript || selectedContactIds.length > 0 || pendingActions.length > 0; if (!hasContent || confirm("Discard unsaved changes?")) setShowForm(false); }} />
            <div className="relative w-full max-w-2xl bg-surface-container-high rounded-[28px] shadow-lg max-h-[90vh] overflow-y-auto">
              <div className="px-6 pt-6 pb-4">
                <h2 className="text-[22px] leading-7 font-normal text-foreground">{editingMeeting ? "Edit meeting" : "New meeting"}</h2>
              </div>
              <form onSubmit={handleSubmit} className="px-6 pb-6 space-y-4">
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className={labelClasses}>Date *</label>
                    <DatePicker value={formData.meeting_date} onChange={(v) => setFormData({ ...formData, meeting_date: v })} required />
                  </div>
                  <div>
                    <label className={labelClasses}>Time</label>
                    <TimePicker value={formData.meeting_time} onChange={(v) => setFormData({ ...formData, meeting_time: v })} />
                  </div>
                  <div>
                    <label className={labelClasses}>Type *</label>
                    <Select
                      required
                      value={formData.meeting_type}
                      onChange={(val) => setFormData({ ...formData, meeting_type: val })}
                      placeholder="Select…"
                      options={[
                        { value: "coffee", label: "Coffee Chat" },
                        { value: "video", label: "Video Call" },
                        { value: "phone", label: "Phone Call" },
                        { value: "in-person", label: "In-Person" },
                        { value: "conference", label: "Conference" },
                        { value: "other", label: "Other" },
                      ]}
                    />
                  </div>
                </div>

                {/* Contact picker */}
                <div>
                  <label className={labelClasses}>Contacts</label>
                  {/* Selected chips */}
                  {selectedContactIds.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {selectedContactIds.map((id) => {
                        const c = allContacts.find((c) => c.id === id);
                        if (!c) return null;
                        return (
                          <span key={id} className="inline-flex items-center gap-1 h-8 pl-3 pr-1.5 rounded-full bg-secondary-container text-xs text-on-secondary-container font-medium">
                            {c.name}
                            <button type="button" onClick={() => setSelectedContactIds(selectedContactIds.filter((i) => i !== id))} className="p-0.5 rounded-full hover:bg-black/10 cursor-pointer">
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </span>
                        );
                      })}
                    </div>
                  )}
                  {/* Search input */}
                  <div className="relative">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                    <input
                      type="text"
                      value={contactSearch}
                      onChange={(e) => setContactSearch(e.target.value)}
                      className={`${inputClasses} !pl-10`}
                      placeholder="Search contacts to add…"
                    />
                  </div>
                  {/* Dropdown results */}
                  {contactSearch.trim() && (
                    <div className="mt-1 max-h-40 overflow-y-auto rounded-[12px] border border-outline-variant bg-surface-container-high">
                      {allContacts
                        .filter((c) => !selectedContactIds.includes(c.id) && c.name.toLowerCase().includes(contactSearch.toLowerCase()))
                        .slice(0, 8)
                        .map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => { setSelectedContactIds([...selectedContactIds, c.id]); setContactSearch(""); }}
                            className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-surface-container cursor-pointer transition-colors"
                          >
                            <div className="w-7 h-7 rounded-full bg-secondary-container flex items-center justify-center shrink-0 text-on-secondary-container text-[11px] font-medium">
                              {c.name.charAt(0).toUpperCase()}
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm text-foreground truncate">{c.name}</p>
                            </div>
                          </button>
                        ))}
                      {allContacts.filter((c) => !selectedContactIds.includes(c.id) && c.name.toLowerCase().includes(contactSearch.toLowerCase())).length === 0 && (
                        <p className="px-4 py-3 text-xs text-muted-foreground">No matching contacts</p>
                      )}
                    </div>
                  )}
                </div>

                <div>
                  <label className={labelClasses}>Notes</label>
                  <textarea value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} className={`${inputClasses} !h-auto py-3`} rows={6} placeholder="Key takeaways, action items…" />
                </div>
                <div>
                  <label className={labelClasses}>Transcript</label>
                  <textarea value={formData.transcript} onChange={(e) => setFormData({ ...formData, transcript: e.target.value })} className={`${inputClasses} !h-auto py-3`} rows={12} placeholder="Paste your full meeting transcript here…" />
                </div>

                {/* Action items section */}
                <div className="pt-2 border-t border-outline-variant">
                  <label className={labelClasses}>
                    <span className="flex items-center gap-1.5"><CheckSquare className="h-3.5 w-3.5" /> Action items</span>
                  </label>

                  {/* Existing action items (from DB) */}
                  {existingActions.length > 0 && (
                    <div className="space-y-1.5 mb-3">
                      {existingActions.map((a) => (
                        editingActionId === a.id ? (
                          <div key={a.id} className="p-3 rounded-[8px] bg-surface-container space-y-2">
                            <input type="text" value={editActionTitle} onChange={(e) => setEditActionTitle(e.target.value)} className={`${inputClasses} !h-10 text-sm`} placeholder="Title" />
                            <textarea value={editActionDescription} onChange={(e) => setEditActionDescription(e.target.value)} className={`${inputClasses} !h-auto py-2 text-sm`} rows={2} placeholder="Description (optional)" />
                            <DatePicker value={editActionDueDate} onChange={setEditActionDueDate} placeholder="No due date" />
                            <div>
                              <label className="block text-xs font-medium text-muted-foreground mb-1.5">Contacts</label>
                              <ContactPicker allContacts={allContacts} selectedIds={editActionContactIds} onChange={setEditActionContactIds} />
                            </div>
                            <div className="flex justify-end gap-2">
                              <Button type="button" variant="text" size="sm" onClick={() => setEditingActionId(null)}>Cancel</Button>
                              <Button type="button" size="sm" onClick={async () => {
                                try {
                                  await updateActionItem(a.id, { title: editActionTitle.trim(), description: editActionDescription.trim() || null, due_at: editActionDueDate || null, contact_id: editActionContactIds[0] ?? null });
                                  await replaceContactsForActionItem(a.id, editActionContactIds);
                                  const refreshed = await getActionItemsForMeeting(editingMeeting!.id);
                                  setExistingActions(refreshed as typeof existingActions);
                                  setEditingActionId(null);
                                } catch (err) { console.error("Error updating action:", err); }
                              }}>Save</Button>
                            </div>
                          </div>
                        ) : (
                          <div key={a.id} className={`flex items-center gap-2 p-2.5 rounded-[8px] ${a.is_completed ? "bg-surface-container opacity-60" : "bg-surface-container"}`}>
                            {a.is_completed
                              ? <Check className="h-4 w-4 text-muted-foreground shrink-0" />
                              : <CheckSquare className="h-4 w-4 text-primary shrink-0" />
                            }
                            <div className="flex-1 min-w-0">
                              <p className={`text-sm truncate ${a.is_completed ? "text-muted-foreground line-through" : "text-foreground"}`}>{a.title}</p>
                              <p className="text-xs text-muted-foreground">
                                {(a.action_item_contacts?.map(ac => ac.contacts?.name).filter(Boolean).join(", ")) || a.contacts?.name || "No contact"}{a.due_at ? ` · Due ${new Date(a.due_at).toLocaleDateString()}` : ""}
                                {a.is_completed && " · Completed"}
                              </p>
                            </div>
                            <div className="flex items-center gap-0.5 shrink-0">
                              <button type="button" onClick={() => { setEditingActionId(a.id); setEditActionTitle(a.title); setEditActionDescription(a.description || ""); setEditActionDueDate(a.due_at ? a.due_at.split("T")[0] : ""); setEditActionContactIds(a.action_item_contacts?.map(ac => ac.contact_id) ?? (a.contact_id ? [a.contact_id] : [])); }} className="p-1.5 rounded-full text-muted-foreground hover:text-foreground cursor-pointer" title="Edit">
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              {a.is_completed ? (
                                <button type="button" onClick={async () => { try { await updateActionItem(a.id, { is_completed: false, completed_at: null }); setExistingActions(existingActions.map(x => x.id === a.id ? { ...x, is_completed: false } : x)); } catch {} }} className="p-1.5 rounded-full text-muted-foreground hover:text-primary cursor-pointer" title="Restore">
                                  <RotateCcw className="h-3.5 w-3.5" />
                                </button>
                              ) : (
                                <button type="button" onClick={async () => { try { await updateActionItem(a.id, { is_completed: true, completed_at: new Date().toISOString() }); setExistingActions(existingActions.map(x => x.id === a.id ? { ...x, is_completed: true } : x)); } catch {} }} className="p-1.5 rounded-full text-muted-foreground hover:text-primary cursor-pointer" title="Mark done">
                                  <Check className="h-3.5 w-3.5" />
                                </button>
                              )}
                              <button type="button" onClick={async () => { if (!confirm("Delete this action item?")) return; try { await deleteActionItem(a.id); setExistingActions(existingActions.filter(x => x.id !== a.id)); } catch {} }} className="p-1.5 rounded-full text-muted-foreground hover:text-destructive cursor-pointer" title="Delete">
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        )
                      ))}
                    </div>
                  )}

                  {/* Pending list (new, not yet saved) */}
                  {pendingActions.length > 0 && (
                    <div className="space-y-1.5 mb-3">
                      {pendingActions.map((a, i) => {
                        const names = a.contactIds.map((id) => allContacts.find((c) => c.id === id)?.name).filter(Boolean).join(", ");
                        return (
                          <div key={`new-${i}`} className="flex items-center gap-2 p-2.5 rounded-[8px] bg-secondary-container/50">
                            <CheckSquare className="h-4 w-4 text-primary shrink-0" />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-foreground truncate">{a.title}</p>
                              <p className="text-xs text-muted-foreground">
                                {names || "No contact"}{a.dueDate ? ` · Due ${new Date(a.dueDate).toLocaleDateString()}` : ""}
                                <span className="text-primary"> · New</span>
                              </p>
                            </div>
                            <button type="button" onClick={() => setPendingActions(pendingActions.filter((_, j) => j !== i))} className="p-1 rounded-full text-muted-foreground hover:text-destructive cursor-pointer">
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <Button type="button" variant="tonal" size="sm" onClick={() => {
                    // Auto-populate all meeting contacts
                    setActionContactIds([...selectedContactIds]);
                    setShowActionSub(true);
                  }}>
                    <Plus className="h-4 w-4" /> Add action item
                  </Button>
                </div>

                {/* Google Calendar toggle — only for new meetings with time set */}
                {calendarConnected && !editingMeeting && (
                  <div className="pt-2 border-t border-outline-variant space-y-3">
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-medium text-foreground flex items-center gap-2">
                        <Calendar className="h-4 w-4 text-muted-foreground" />
                        Add to Google Calendar
                      </label>
                      <button
                        type="button"
                        onClick={() => setAddToCalendar(!addToCalendar)}
                        className={`relative w-10 h-6 rounded-full transition-colors ${
                          addToCalendar ? "bg-primary" : "bg-outline-variant"
                        }`}
                      >
                        <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${
                          addToCalendar ? "left-5" : "left-1"
                        }`} />
                      </button>
                    </div>
                    {addToCalendar && (
                      <>
                        <div className="flex items-center justify-between">
                          <label className="text-sm text-muted-foreground flex items-center gap-2">
                            <span className="text-lg">📹</span> Include Google Meet link
                          </label>
                          <button
                            type="button"
                            onClick={() => setIncludeMeetLink(!includeMeetLink)}
                            className={`relative w-10 h-6 rounded-full transition-colors ${
                              includeMeetLink ? "bg-primary" : "bg-outline-variant"
                            }`}
                          >
                            <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${
                              includeMeetLink ? "left-5" : "left-1"
                            }`} />
                          </button>
                        </div>
                        <div>
                          <label className={labelClasses}>Meeting duration</label>
                          <select
                            value={meetingDuration}
                            onChange={(e) => setMeetingDuration(Number(e.target.value))}
                            className={inputClasses}
                          >
                            <option value={15}>15 minutes</option>
                            <option value={30}>30 minutes</option>
                            <option value={45}>45 minutes</option>
                            <option value={60}>1 hour</option>
                            <option value={90}>1.5 hours</option>
                            <option value={120}>2 hours</option>
                          </select>
                        </div>
                      </>
                    )}
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-2">
                  <Button type="button" variant="text" onClick={closeForm}>Cancel</Button>
                  <Button type="submit">{editingMeeting ? "Save" : "Create"}</Button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Action item sub-modal */}
        {showActionSub && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/32" onClick={() => { setShowActionSub(false); setActionTitle(""); setActionDescription(""); setActionContactIds([]); setActionDueDate(""); }} />
            <div className="relative w-full max-w-md bg-surface-container-high rounded-[28px] shadow-lg">
              <div className="px-6 pt-6 pb-4">
                <h2 className="text-[22px] leading-7 font-normal text-foreground">New action item</h2>
              </div>
              <div className="px-6 pb-6 space-y-4">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Title *</label>
                  <input
                    type="text"
                    value={actionTitle}
                    onChange={(e) => setActionTitle(e.target.value)}
                    className={inputClasses}
                    placeholder="Follow up about…"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Description</label>
                  <textarea
                    value={actionDescription}
                    onChange={(e) => setActionDescription(e.target.value)}
                    className={`${inputClasses} !h-auto py-3`}
                    rows={2}
                    placeholder="Optional details…"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Assign to contacts *</label>
                  <ContactPicker allContacts={allContacts} selectedIds={actionContactIds} onChange={setActionContactIds} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Due date</label>
                  <DatePicker value={actionDueDate} onChange={setActionDueDate} placeholder="No due date" />
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <Button type="button" variant="text" onClick={() => { setShowActionSub(false); setActionTitle(""); setActionDescription(""); setActionContactIds([]); setActionDueDate(""); }}>
                    Cancel
                  </Button>
                  <Button type="button" disabled={!actionTitle.trim() || actionContactIds.length === 0} onClick={addPendingAction}>
                    Add
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Empty state */}
        {meetings.length === 0 && allInteractions.length === 0 && (
          <Card variant="outlined" className="text-center py-16">
            <CardContent>
              <Calendar className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-base text-foreground mb-1">No activity yet</p>
              <p className="text-sm text-muted-foreground mb-6">Log a meeting or interaction to start tracking.</p>
              <div className="flex justify-center gap-2">
                <Button onClick={() => setShowForm(true)}>
                  <Plus className="h-[18px] w-[18px]" /> Add meeting
                </Button>
                <Button variant="tonal" onClick={() => {
                  setInteractionContactId(null);
                  setInteractionForm({ interaction_date: new Date().toISOString().split("T")[0], interaction_type: "", summary: "" });
                  setShowInteractionModal(true);
                }}>
                  <MessageSquare className="h-[18px] w-[18px]" /> Add interaction
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Unified timeline: meetings + interactions sorted by date desc */}
        <div className="space-y-3">
          {(() => {
            const timeline: { kind: "meeting" | "interaction"; date: string; data: Meeting | InteractionWithContact }[] = [
              ...meetings.map((m) => ({ kind: "meeting" as const, date: m.meeting_date, data: m })),
              ...allInteractions.map((i) => ({ kind: "interaction" as const, date: i.interaction_date, data: i })),
            ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

            return timeline.map((item) => item.kind === "interaction" ? (
              <div key={`i-${(item.data as InteractionWithContact).id}`} className="rounded-[16px] border border-outline-variant/60 bg-white hover:border-outline-variant hover:shadow-sm transition-all duration-200">
                <div className="p-5">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-full bg-primary-container flex items-center justify-center shrink-0">
                        <MessageSquare className="h-5 w-5 text-on-primary-container" />
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
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-full bg-secondary-container flex items-center justify-center shrink-0">
                      <Calendar className="h-5 w-5 text-on-secondary-container" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-base font-medium text-foreground capitalize">{meeting.meeting_type}</h3>
                      <p className="text-sm text-muted-foreground">
                        {new Date(meeting.meeting_date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
                        {" · "}
                        {new Date(meeting.meeting_date).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                      </p>
                    </div>
                  </div>
                  <button onClick={() => handleEdit(meeting)} className="p-2 rounded-full text-muted-foreground hover:text-primary cursor-pointer transition-colors">
                    <Pencil className="h-[18px] w-[18px]" />
                  </button>
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

                {meeting.notes && (
                  <div className="mt-4 ml-[52px]">
                    <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">Notes</h4>
                    <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{meeting.notes}</p>
                  </div>
                )}

                {meeting.transcript && (
                  <div className="mt-4 ml-[52px]">
                    <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">Transcript</h4>
                    <div className="bg-surface-container-low rounded-[12px] p-4 max-h-48 overflow-y-auto">
                      <p className="whitespace-pre-wrap text-sm text-foreground leading-relaxed">{meeting.transcript}</p>
                    </div>
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

      {/* Interaction creation modal */}
      {showInteractionModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/32" onClick={() => { const hasContent = interactionForm.interaction_type || interactionForm.summary || interactionContactId; if (!hasContent || confirm("Discard unsaved changes?")) setShowInteractionModal(false); }} />
          <div className="relative w-full max-w-lg bg-surface-container-high rounded-[28px] shadow-lg max-h-[90vh] overflow-y-auto">
            <div className="px-6 pt-6 pb-4">
              <h2 className="text-[22px] leading-7 font-normal text-foreground">Log interaction</h2>
            </div>
            <div className="px-6 pb-6 space-y-4">
              <div>
                <label className={labelClasses}>Contact *</label>
                <Select
                  value={interactionContactId?.toString() || ""}
                  onChange={(v) => setInteractionContactId(parseInt(v))}
                  options={allContacts.map((c: SimpleContact) => ({ value: c.id.toString(), label: c.name }))}
                  placeholder="Select contact"
                />
              </div>
              <div>
                <label className={labelClasses}>Date *</label>
                <DatePicker value={interactionForm.interaction_date} onChange={(v) => setInteractionForm(f => ({ ...f, interaction_date: v }))} placeholder="Interaction date" />
              </div>
              <div>
                <label className={labelClasses}>Type *</label>
                <Select
                  value={interactionForm.interaction_type}
                  onChange={(v) => setInteractionForm(f => ({ ...f, interaction_type: v }))}
                  options={[
                    { value: "coffee", label: "Coffee" },
                    { value: "video", label: "Video call" },
                    { value: "phone", label: "Phone call" },
                    { value: "email", label: "Email" },
                    { value: "lunch", label: "Lunch" },
                    { value: "event", label: "Event" },
                    { value: "other", label: "Other" },
                  ]}
                  placeholder="Select type"
                />
              </div>
              <div>
                <label className={labelClasses}>Summary</label>
                <textarea
                  value={interactionForm.summary}
                  onChange={(e) => setInteractionForm(f => ({ ...f, summary: e.target.value }))}
                  className={`${inputClasses} !h-auto py-3`}
                  rows={3}
                  placeholder="What did you discuss?"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="text" onClick={() => setShowInteractionModal(false)}>Cancel</Button>
                <Button
                  type="button"
                  disabled={!interactionContactId || !interactionForm.interaction_date || !interactionForm.interaction_type || interactionSaving}
                  loading={interactionSaving}
                  onClick={async () => {
                    if (!interactionContactId || !interactionForm.interaction_date || !interactionForm.interaction_type) return;
                    setInteractionSaving(true);
                    try {
                      await createInteraction({
                        contact_id: interactionContactId,
                        interaction_date: interactionForm.interaction_date,
                        interaction_type: interactionForm.interaction_type,
                        summary: interactionForm.summary.trim() || null,
                      });
                      await loadInteractions();
                      setShowInteractionModal(false);
                    } catch (err) {
                      console.error("Error creating interaction:", err);
                    } finally {
                      setInteractionSaving(false);
                    }
                  }}
                >
                  Save
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
