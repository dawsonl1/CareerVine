"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLatestRequest } from "@/hooks/use-latest-request";
import { Modal, ModalCancelButton } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { LoadErrorBanner } from "@/components/ui/load-error-state";
import { EmailMessageBody } from "@/components/email/email-message-body";
import TranscriptViewer from "@/components/transcript-viewer";
import { useEmailBody } from "@/hooks/use-email-body";
import { useCompose } from "@/components/compose-email-context";
import { useQuickCapture } from "@/components/quick-capture-context";
import { withToastOnError } from "@/lib/with-toast-on-error";
import { apiSend, jsonBody } from "@/lib/api-client";
import { getMeetingById, deleteMeeting, getTranscriptSegments } from "@/lib/data/meetings";
import { getActionItemsForMeeting, deleteActionItem, updateActionItem } from "@/lib/data/action-items";
import { getAttachmentsForMeeting, getAttachmentUrl } from "@/lib/data/attachments";
import { updateInteraction, deleteInteraction } from "@/lib/data/interactions";
import { formatWallClock } from "@/lib/calendar-day";
import { inputClasses, labelClasses } from "@/lib/form-styles";
import {
  CONVERSATION_TYPE_OPTIONS,
  CONVERSATION_TYPE_HINT,
  CONVERSATION_TYPE_DETAIL_MAX_LENGTH,
  ConversationType,
  ActionDirection,
  SYSTEM_INTERACTION_TYPE_EMAIL,
  conversationTypeLabel,
  normalizeConversationTypeDetail,
} from "@/lib/constants";
import type {
  ActionItemWithContacts,
  Meeting,
  TimelineEntry,
  TranscriptSegment,
} from "@/lib/types";
import { invalidateCompanyScopes } from "@/lib/company-detail-cache";
import { refreshCompaniesList } from "@/lib/companies-list-cache";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Calendar,
  CheckCircle,
  CheckSquare,
  EyeOff,
  MessageSquare,
  Paperclip,
  Pencil,
  Reply,
  RotateCcw,
  Trash2,
} from "lucide-react";

type MeetingAttachment = Awaited<ReturnType<typeof getAttachmentsForMeeting>>[number];

/**
 * The detail view behind every contact-timeline row (CAR-249).
 *
 * OWNED BY THE PAGE, NOT THE TIMELINE TAB, and that placement is load-bearing.
 * The tab renders inside a `SectionBoundary` keyed on `dataGeneration`, which
 * every completed background refresh bumps by design, so a modal mounted in the
 * tab is torn down mid-interaction whenever a refresh lands — the same defect
 * CAR-204 fixed for the delete confirmation. That is also why the interaction
 * EDIT form now lives here rather than in the tab: in its old home a refresh
 * silently discarded a half-typed edit.
 *
 * Editing hands off to whoever already owns the record's form. A meeting opens
 * the conversation modal in edit mode (`useQuickCapture().openEdit`), because a
 * second meeting form would be a second place for the calendar sync, the
 * transcript segment cleanup and the type/detail CHECK to drift.
 */
export function TimelineDetailModal({
  entry,
  contactName,
  canReadMailbox,
  gmailConnected,
  onClose,
  onChanged,
  onConfirmDelete,
}: {
  /** The clicked row, or null when closed. */
  entry: TimelineEntry | null;
  contactName: string;
  /** CAR-102 premium live-mailbox scope; gates the email body fetch. */
  canReadMailbox: boolean;
  gmailConnected: boolean;
  onClose: () => void;
  /** Re-read the page's timeline data after a write. */
  onChanged: () => void;
  /**
   * Asks the user to confirm a destructive action. Owned by the PAGE for the
   * same reason this component is: a `useConfirm` below the keyed boundary is
   * unmounted mid-question by a background refresh (CAR-204).
   */
  onConfirmDelete: (options: { message: string; title?: string }) => Promise<boolean>;
}) {
  const { error: toastError, success: toastSuccess } = useToast();
  const { openCompose } = useCompose();
  const { openEdit } = useQuickCapture();

  // Every write reachable from this modal (excluding or restoring a timeline
  // entry, deleting a meeting or interaction) changes what stage derivation
  // sees, and so changes the badges on a company roster that is cached and
  // unmounted (CAR-268). One wrapper, because they all report through here.
  const handleChanged = useCallback(() => {
    invalidateCompanyScopes();
    // Traction on the /companies card is derived from exactly the
    // interactions this excludes and restores.
    refreshCompaniesList();
    onChanged();
  }, [onChanged]);

  const isOpen = !!entry;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={entry ? headline(entry) : undefined}
      size="lg"
    >
      {entry?.kind === "meeting" && (
        <MeetingDetail
          meetingId={entry.data.id}
          onClose={onClose}
          onChanged={handleChanged}
          onConfirmDelete={onConfirmDelete}
          onEdit={(meeting, actions) => {
            // Close first: the conversation modal is a sibling dialog, and
            // stacking two full-height surfaces buries the one being edited.
            onClose();
            openEdit(meeting, actions);
          }}
          toastError={toastError}
          toastSuccess={toastSuccess}
        />
      )}

      {entry?.kind === "interaction" && (
        <InteractionDetail
          interaction={entry.data}
          onClose={onClose}
          onChanged={handleChanged}
          onConfirmDelete={onConfirmDelete}
          toastError={toastError}
        />
      )}

      {entry?.kind === "email" && (
        <EmailDetail
          message={entry.data}
          contactName={contactName}
          canReadMailbox={canReadMailbox}
          gmailConnected={gmailConnected}
          onReply={openCompose}
        />
      )}

      {entry?.kind === "completed_action" && (
        <CompletedActionDetail
          action={entry.data}
          onClose={onClose}
          onChanged={handleChanged}
          onConfirmDelete={onConfirmDelete}
          toastError={toastError}
        />
      )}

      {entry && (
        <CountToggle
          entry={entry}
          onClose={onClose}
          onChanged={handleChanged}
          onConfirm={onConfirmDelete}
          toastError={toastError}
        />
      )}
    </Modal>
  );
}

/** Where the entry lives, for the copy that promises it survives removal. */
const SURVIVES: Partial<Record<TimelineEntry["kind"], string>> = {
  email: " The message stays in Gmail.",
  meeting: " The event stays in Google Calendar if it came from there.",
};

/**
 * Strike this entry from every derived calculation, or put it back (CAR-260).
 *
 * Shared across all four kinds rather than added to each detail component,
 * because "does not count" has to mean one identical thing everywhere or the
 * user cannot predict it. Deliberately NOT merged with the per-kind Delete
 * buttons above: those destroy the record, this keeps it and stops it counting,
 * and the two are different enough that collapsing them would make Delete
 * quietly reversible. The label is the user's own phrasing for the same reason
 * "Remove" was rejected: it is a synonym for Delete and would read as a
 * duplicate of it.
 */
function CountToggle({
  entry,
  onClose,
  onChanged,
  onConfirm,
  toastError,
}: {
  entry: TimelineEntry;
  onClose: () => void;
  onChanged: () => void;
  onConfirm: (options: { message: string; title?: string }) => Promise<boolean>;
  toastError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const excluded = !!entry.data.is_excluded;

  const body =
    entry.kind === "email"
      ? { kind: "email" as const, gmailMessageId: entry.data.gmail_message_id }
      : { kind: entry.kind, id: entry.data.id };

  const run = async () => {
    // Claimed BEFORE the confirm, not after it: the confirm is itself an await,
    // so a ref set on the far side of it leaves the whole dialog round trip
    // unguarded and a double click opens two of them.
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if (
        !excluded &&
        !(await onConfirm({
          title: "Stop counting this?",
          message:
            "It stops counting toward your suggestions, company progress and network stats." +
            (SURVIVES[entry.kind] ?? "") +
            " You can put it back with Show removed on the timeline.",
        }))
      ) {
        return;
      }
      const ok = await withToastOnError(
        () => apiSend("/api/timeline/exclude", jsonBody(body, excluded ? "DELETE" : "POST")),
        toastError,
        excluded ? "Couldn't put that back. Please try again." : "Couldn't remove that. Please try again."
      );
      if (!ok) return;
      onChanged();
      onClose();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 pt-3 mt-3 border-t border-outline-variant/50">
      <p className="text-sm text-muted-foreground">
        {excluded
          ? "Removed from your history, so it is not counted anywhere."
          : "Counted toward your suggestions and company progress."}
      </p>
      <Button type="button" variant="text" disabled={busy} onClick={() => void run()}>
        {excluded ? (
          <>
            <RotateCcw className="h-4 w-4" /> Count this again
          </>
        ) : (
          <>
            <EyeOff className="h-4 w-4" /> Do not count this
          </>
        )}
      </Button>
    </div>
  );
}

/** The dialog's accessible name, and its headline. */
function headline(entry: TimelineEntry) {
  switch (entry.kind) {
    case "meeting":
      return (
        entry.data.title ||
        conversationTypeLabel(entry.data.meeting_type, entry.data.meeting_type_detail) ||
        "Meeting"
      );
    case "interaction":
      return (
        conversationTypeLabel(entry.data.interaction_type, entry.data.interaction_type_detail) ||
        "Interaction"
      );
    case "email":
      return entry.data.subject || "(no subject)";
    case "completed_action":
      return entry.data.title;
  }
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
      {children}
    </h4>
  );
}

function DetailMeta({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      {icon}
      <span>{children}</span>
    </div>
  );
}

/* ── Meeting ───────────────────────────────────────────────────────────── */

/**
 * Four independent reads behind one view. They settle through
 * `Promise.allSettled` rather than `Promise.all` so a failed transcript read
 * cannot blank the notes, and each failure gets its own banner instead of
 * rendering as "this meeting has none" — an empty list is an affirmative claim
 * about the user's data.
 */
function MeetingDetail({
  meetingId,
  onClose,
  onChanged,
  onConfirmDelete,
  onEdit,
  toastError,
  toastSuccess,
}: {
  meetingId: number;
  onClose: () => void;
  onChanged: () => void;
  onConfirmDelete: (options: { message: string; title?: string }) => Promise<boolean>;
  onEdit: (meeting: Meeting, actions: ActionItemWithContacts[]) => void;
  toastError: (msg: string) => void;
  toastSuccess: (msg: string) => void;
}) {
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [actions, setActions] = useState<ActionItemWithContacts[] | null>(null);
  const [attachments, setAttachments] = useState<MeetingAttachment[] | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [meetingMissing, setMeetingMissing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const downloadingRef = useRef(false);
  /**
   * Keyed on `meetingId`, which changes under this component: closing one row
   * and opening another swaps the prop rather than remounting, so a slow first
   * read could land over the second meeting's detail (CAR-145 / F19).
   */
  const req = useLatestRequest();

  const load = useCallback(async () => {
    const token = req.begin();
    setLoading(true);
    setMeetingMissing(false);
    const [m, a, att, seg] = await Promise.allSettled([
      getMeetingById(meetingId),
      getActionItemsForMeeting(meetingId),
      getAttachmentsForMeeting(meetingId),
      getTranscriptSegments(meetingId),
    ]);
    if (!req.isLatest(token)) return;
    setMeeting(m.status === "fulfilled" ? m.value : null);
    setMeetingMissing(m.status === "fulfilled" && m.value === null);
    setActions(a.status === "fulfilled" ? (a.value as ActionItemWithContacts[]) : null);
    setAttachments(att.status === "fulfilled" ? att.value : null);
    setSegments(seg.status === "fulfilled" ? (seg.value as TranscriptSegment[]) : null);
    setLoading(false);
  }, [meetingId, req]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDownload = async (objectPath: string, fileName: string) => {
    // Synchronous, not `disabled={downloading}`: the second click of a double
    // click arrives before any state-driven disable has rendered, and each one
    // mints a fresh signed URL and a fresh download.
    if (downloadingRef.current) return;
    downloadingRef.current = true;
    await withToastOnError(
      async () => {
        const url = await getAttachmentUrl(objectPath);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        a.target = "_blank";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      },
      toastError,
      "Couldn't download that attachment. Please try again.",
    );
    downloadingRef.current = false;
  };

  const handleDelete = async () => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    // The action items are NOT deleted with the meeting: follow_up_action_items
    // .meeting_id is ON DELETE SET NULL, so they survive unlinked. Saying "this
    // cannot be undone" without saying that leaves the user expecting the
    // opposite of what happens.
    const orphanCount = actions?.length ?? 0;
    try {
      const confirmed = await onConfirmDelete({
        title: "Delete this conversation?",
        message:
          orphanCount > 0
            ? `This cannot be undone. ${orphanCount} action item${orphanCount === 1 ? "" : "s"} from this conversation will be kept, no longer linked to it.`
            : "This cannot be undone.",
      });
      if (!confirmed) return;

      setDeleting(true);
      const deleted = await withToastOnError(
        () => deleteMeeting(meetingId),
        toastError,
        "Couldn't delete that conversation. Please try again.",
      );
      setDeleting(false);
      if (!deleted) return;

      toastSuccess("Conversation deleted");
      onClose();
      onChanged();
    } finally {
      // Released on EVERY path, declines included: a cancelled confirm that
      // left the ref claimed would disable Delete for the rest of the session.
      deletingRef.current = false;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2.5 text-muted-foreground py-6">
        <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
        <span className="text-sm">Loading…</span>
      </div>
    );
  }

  if (meetingMissing) {
    return (
      <div className="py-2">
        <p className="text-sm text-muted-foreground">
          This conversation no longer exists. It may have been deleted from another tab.
        </p>
        <div className="flex justify-end pt-4">
          <ModalCancelButton>Close</ModalCancelButton>
        </div>
      </div>
    );
  }

  if (!meeting) {
    return (
      <div className="py-2">
        <LoadErrorBanner message="Couldn't load this conversation." onRetry={() => void load()} />
        <div className="flex justify-end pt-4">
          <ModalCancelButton>Close</ModalCancelButton>
        </div>
      </div>
    );
  }

  const typeLabel = conversationTypeLabel(meeting.meeting_type, meeting.meeting_type_detail);

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <DetailMeta icon={<Calendar className="h-4 w-4 shrink-0" />}>
          {formatWallClock(
            meeting.meeting_date,
            { weekday: "long", month: "long", day: "numeric", year: "numeric" },
            "en-US",
          )}
          {" · "}
          {formatWallClock(meeting.meeting_date, { hour: "numeric", minute: "2-digit" }, "en-US")}
        </DetailMeta>
        {/* Suppressed when absent rather than shown as "Meeting": meeting_type is
            nullable, and MCP-created meetings and bare calendar events have none. */}
        {typeLabel && (
          <DetailMeta icon={<MessageSquare className="h-4 w-4 shrink-0" />}>{typeLabel}</DetailMeta>
        )}
      </div>

      {meeting.meeting_contacts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {meeting.meeting_contacts.map((mc) => (
            <span
              key={mc.contact_id}
              className="inline-flex items-center h-8 px-4 rounded-full bg-secondary-container text-sm text-on-secondary-container font-medium"
            >
              {mc.contacts.name}
            </span>
          ))}
        </div>
      )}

      {meeting.notes && (
        <div>
          <SectionHeading>Notes</SectionHeading>
          <p className="text-base text-foreground leading-relaxed whitespace-pre-wrap">{meeting.notes}</p>
        </div>
      )}

      {meeting.private_notes && (
        <div>
          <SectionHeading>Private reminders</SectionHeading>
          <p className="text-base text-foreground leading-relaxed whitespace-pre-wrap">
            {meeting.private_notes}
          </p>
        </div>
      )}

      <div>
        <SectionHeading>Action items</SectionHeading>
        {actions === null ? (
          <LoadErrorBanner
            message="Couldn't load this conversation's action items."
            onRetry={() => void load()}
          />
        ) : actions.length === 0 ? (
          <p className="text-sm text-muted-foreground">None from this conversation.</p>
        ) : (
          <div className="space-y-1.5">
            {actions.map((action) => (
              <div key={action.id} className="flex items-center gap-2.5 text-base">
                <CheckSquare
                  className={`h-4 w-4 shrink-0 ${action.is_completed ? "text-primary" : "text-muted-foreground"}`}
                />
                <span
                  className={`flex-1 min-w-0 truncate ${action.is_completed ? "line-through text-muted-foreground" : "text-foreground"}`}
                >
                  {action.title}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {(meeting.transcript || (segments?.length ?? 0) > 0) && (
        <div>
          <SectionHeading>Transcript</SectionHeading>
          {segments === null && meeting.transcript === null ? (
            <LoadErrorBanner
              message="Couldn't load this conversation's transcript."
              onRetry={() => void load()}
            />
          ) : (
            <TranscriptViewer segments={segments ?? undefined} rawText={meeting.transcript} />
          )}
        </div>
      )}

      {attachments === null ? (
        <div>
          <SectionHeading>Attachments</SectionHeading>
          <LoadErrorBanner
            message="Couldn't load this conversation's attachments."
            onRetry={() => void load()}
          />
        </div>
      ) : attachments.length > 0 ? (
        <div>
          <SectionHeading>Attachments</SectionHeading>
          <div className="space-y-1.5">
            {attachments.map((att) => (
              <div key={att.id} className="flex items-center gap-2.5 text-base">
                <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
                <button
                  type="button"
                  className="text-primary hover:underline truncate cursor-pointer text-left"
                  onClick={() => void handleDownload(att.object_path, att.file_name)}
                >
                  {att.file_name}
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex justify-between items-center gap-2 pt-2 border-t border-outline-variant/50">
        <Button
          type="button"
          variant="text"
          disabled={deleting}
          onClick={() => void handleDelete()}
          className="!text-destructive hover:!bg-destructive/10"
        >
          <Trash2 className="h-4 w-4" /> Delete
        </Button>
        <div className="flex gap-2">
          <ModalCancelButton disabled={deleting}>Close</ModalCancelButton>
          <Button type="button" disabled={deleting} onClick={() => onEdit(meeting, actions ?? [])}>
            <Pencil className="h-4 w-4" /> Edit
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ── Interaction ───────────────────────────────────────────────────────── */

function InteractionDetail({
  interaction,
  onClose,
  onChanged,
  onConfirmDelete,
  toastError,
}: {
  interaction: Extract<TimelineEntry, { kind: "interaction" }>["data"];
  onClose: () => void;
  onChanged: () => void;
  onConfirmDelete: (options: { message: string; title?: string }) => Promise<boolean>;
  toastError: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  // Synchronous, separate from the `saving` UI state: `disabled={saving}` has
  // not rendered when the second click of a double click arrives.
  const savingRef = useRef(false);
  const deletingRef = useRef(false);
  const [form, setForm] = useState({
    interaction_date: interaction.interaction_date,
    interaction_type: interaction.interaction_type,
    interaction_type_detail: interaction.interaction_type_detail || "",
    summary: interaction.summary || "",
  });

  /**
   * The five user-selectable types, plus `email` ONLY while editing a row the
   * send path wrote. `email` is system-written and deliberately absent from
   * CONVERSATION_TYPE_OPTIONS, but every interaction in production carries it —
   * without this the picker would render blank on the one kind of row that
   * actually exists, and saving would silently retype a sent email.
   */
  const typeOptions = useMemo(() => {
    const base = CONVERSATION_TYPE_OPTIONS.map(({ value, label }) => ({ value, label }));
    return interaction.interaction_type === SYSTEM_INTERACTION_TYPE_EMAIL
      ? [...base, { value: SYSTEM_INTERACTION_TYPE_EMAIL, label: "Email" }]
      : base;
  }, [interaction.interaction_type]);

  const handleSave = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const saved = await withToastOnError(
        async () => {
          await updateInteraction(interaction.id, {
            interaction_date: form.interaction_date,
            interaction_type: form.interaction_type,
            // The detail CHECK rejects free text carried over from a type the
            // user switched away from.
            interaction_type_detail: normalizeConversationTypeDetail(
              form.interaction_type,
              form.interaction_type_detail,
            ),
            summary: form.summary || null,
          });
        },
        toastError,
        "Couldn't save that interaction. Please try again.",
      );
      setSaving(false);
      if (!saved) return;
      onClose();
      onChanged();
    } finally {
      savingRef.current = false;
    }
  };

  const handleDelete = async () => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    try {
      if (!(await onConfirmDelete({ message: "Delete this interaction?" }))) return;
      const deleted = await withToastOnError(
        async () => {
          await deleteInteraction(interaction.id);
        },
        toastError,
        "Couldn't delete that interaction. Please try again.",
      );
      if (!deleted) return;
      onClose();
      onChanged();
    } finally {
      deletingRef.current = false;
    }
  };

  if (editing) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClasses}>Date &amp; Time *</label>
            <input
              type="datetime-local"
              required
              value={form.interaction_date}
              onChange={(e) => setForm({ ...form, interaction_date: e.target.value })}
              className={inputClasses}
            />
          </div>
          <div>
            <label className={labelClasses}>Type *</label>
            <Select
              ariaLabel="Interaction type"
              value={form.interaction_type}
              onChange={(val) =>
                setForm({
                  ...form,
                  interaction_type: val,
                  interaction_type_detail:
                    val === ConversationType.Other ? form.interaction_type_detail : "",
                })
              }
              placeholder="Select..."
              options={typeOptions}
            />
          </div>
        </div>
        <p className="-mt-2 text-sm text-muted-foreground">{CONVERSATION_TYPE_HINT}</p>
        {form.interaction_type === ConversationType.Other && (
          <div>
            <label className={labelClasses}>What kind of conversation?</label>
            <input
              type="text"
              value={form.interaction_type_detail}
              onChange={(e) => setForm({ ...form, interaction_type_detail: e.target.value })}
              maxLength={CONVERSATION_TYPE_DETAIL_MAX_LENGTH}
              className={inputClasses}
              placeholder="e.g. Alumni panel"
            />
          </div>
        )}
        <div>
          <label className={labelClasses}>Summary</label>
          <textarea
            value={form.summary}
            onChange={(e) => setForm({ ...form, summary: e.target.value })}
            className={`${inputClasses} !h-auto py-3`}
            rows={4}
            placeholder="What was discussed? Key takeaways?"
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="text" disabled={saving} onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!form.interaction_date || !form.interaction_type || saving}
            loading={saving}
            onClick={() => void handleSave()}
          >
            Save
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <DetailMeta icon={<Calendar className="h-4 w-4 shrink-0" />}>
        {new Date(interaction.interaction_date).toLocaleString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}
      </DetailMeta>

      <div>
        <SectionHeading>Summary</SectionHeading>
        {interaction.summary ? (
          <p className="text-base text-foreground leading-relaxed whitespace-pre-wrap">
            {interaction.summary}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing was recorded for this interaction.</p>
        )}
      </div>

      <div className="flex justify-between items-center gap-2 pt-2 border-t border-outline-variant/50">
        <Button
          type="button"
          variant="text"
          onClick={() => void handleDelete()}
          className="!text-destructive hover:!bg-destructive/10"
        >
          <Trash2 className="h-4 w-4" /> Delete
        </Button>
        <div className="flex gap-2">
          <ModalCancelButton>Close</ModalCancelButton>
          <Button type="button" onClick={() => setEditing(true)}>
            <Pencil className="h-4 w-4" /> Edit
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ── Email ─────────────────────────────────────────────────────────────── */

/**
 * Read-only by design: these rows mirror Gmail rather than owning the message,
 * so an "edit" would change nothing the user would see anywhere else and a
 * "delete" would resurrect on the next sync.
 */
function EmailDetail({
  message,
  contactName,
  canReadMailbox,
  gmailConnected,
  onReply,
}: {
  message: Extract<TimelineEntry, { kind: "email" }>["data"];
  contactName: string;
  canReadMailbox: boolean;
  gmailConnected: boolean;
  onReply: ReturnType<typeof useCompose>["openCompose"];
}) {
  const { content, loading, failed, load } = useEmailBody({ canReadMailbox });

  useEffect(() => {
    void load(message);
  }, [load, message]);

  return (
    <div className="space-y-5">
      <DetailMeta
        icon={
          message.direction === "outbound" ? (
            <ArrowUpRight className="h-4 w-4 shrink-0 text-primary" />
          ) : (
            <ArrowDownLeft className="h-4 w-4 shrink-0 text-tertiary" />
          )
        }
      >
        {message.direction === "outbound" ? "Sent by you" : "Received"}
      </DetailMeta>

      <EmailMessageBody
        content={content}
        loading={loading}
        failed={failed}
        maxBodyHeightClass="max-h-[45vh]"
      />

      <div className="flex justify-end items-center gap-2 pt-2 border-t border-outline-variant/50">
        <ModalCancelButton>Close</ModalCancelButton>
        {gmailConnected && content && !loading && (
          <Button
            type="button"
            onClick={() => {
              const replyTo =
                message.direction === "outbound"
                  ? message.to_addresses?.[0] || ""
                  : message.from_address || "";
              const reSubj = (content.subject || "").replace(/^(Re:\s*)+/i, "");
              onReply({
                to: replyTo,
                name: contactName,
                subject: `Re: ${reSubj}`,
                threadId: content.threadId,
                inReplyTo: content.messageId,
                references: content.messageId,
                quotedHtml: content.bodyHtml || content.bodyText || "",
              });
            }}
          >
            <Reply className="h-4 w-4" /> Reply
          </Button>
        )}
      </div>
    </div>
  );
}

/* ── Completed action ──────────────────────────────────────────────────── */

function CompletedActionDetail({
  action,
  onClose,
  onChanged,
  onConfirmDelete,
  toastError,
}: {
  action: Extract<TimelineEntry, { kind: "completed_action" }>["data"];
  onClose: () => void;
  onChanged: () => void;
  onConfirmDelete: (options: { message: string; title?: string }) => Promise<boolean>;
  toastError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  // One ref for both actions: reopening and deleting the same item concurrently
  // is as wrong as doing either twice. Synchronous, because `disabled={busy}`
  // has not rendered when a double click's second event arrives.
  const busyRef = useRef(false);

  const handleReopen = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const reopened = await withToastOnError(
        async () => {
          await updateActionItem(action.id, { is_completed: false, completed_at: null });
        },
        toastError,
        "Couldn't reopen that action item. Please try again.",
      );
      setBusy(false);
      if (!reopened) return;
      onClose();
      onChanged();
    } finally {
      busyRef.current = false;
    }
  };

  const handleDelete = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      if (!(await onConfirmDelete({ message: "Delete this action item? This cannot be undone." })))
        return;
      setBusy(true);
      const deleted = await withToastOnError(
        async () => {
          await deleteActionItem(action.id);
        },
        toastError,
        "Couldn't delete that action item. Please try again.",
      );
      setBusy(false);
      if (!deleted) return;
      onClose();
      onChanged();
    } finally {
      busyRef.current = false;
    }
  };

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <DetailMeta icon={<CheckCircle className="h-4 w-4 shrink-0 text-primary" />}>
          Completed{" "}
          {action.completed_at
            ? new Date(action.completed_at).toLocaleString("en-US", {
                month: "long",
                day: "numeric",
                year: "numeric",
              })
            : ""}
        </DetailMeta>
        {action.due_at && (
          <DetailMeta icon={<Calendar className="h-4 w-4 shrink-0" />}>
            Was due{" "}
            {new Date(action.due_at).toLocaleDateString("en-US", {
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </DetailMeta>
        )}
        {action.direction === ActionDirection.WaitingOn && (
          <DetailMeta icon={<MessageSquare className="h-4 w-4 shrink-0" />}>
            You were waiting on them for this
          </DetailMeta>
        )}
      </div>

      {action.description && (
        <div>
          <SectionHeading>Details</SectionHeading>
          <p className="text-base text-foreground leading-relaxed whitespace-pre-wrap">
            {action.description}
          </p>
        </div>
      )}

      <div className="flex justify-between items-center gap-2 pt-2 border-t border-outline-variant/50">
        <Button
          type="button"
          variant="text"
          disabled={busy}
          onClick={() => void handleDelete()}
          className="!text-destructive hover:!bg-destructive/10"
        >
          <Trash2 className="h-4 w-4" /> Delete
        </Button>
        <div className="flex gap-2">
          <ModalCancelButton disabled={busy}>Close</ModalCancelButton>
          <Button type="button" disabled={busy} onClick={() => void handleReopen()}>
            <RotateCcw className="h-4 w-4" /> Reopen
          </Button>
        </div>
      </div>
    </div>
  );
}
