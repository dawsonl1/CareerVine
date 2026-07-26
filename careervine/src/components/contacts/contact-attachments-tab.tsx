"use client";

import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { uploadAttachment, addAttachmentToContact, getAttachmentUrl, deleteAttachment, getAttachmentsForContact } from "@/lib/queries";
import { useToast } from "@/components/ui/toast";
import { withToastOnError } from "@/lib/with-toast-on-error";
import { Paperclip, Plus, Trash2 } from "lucide-react";

type Attachment = {
  id: number;
  file_name: string;
  content_type: string | null;
  file_size_bytes: number | null;
  object_path: string;
  created_at: string | null;
};

interface ContactAttachmentsTabProps {
  contactId: number;
  userId: string;
  attachments: Attachment[];
  /**
   * True while the related-data read is in flight. This tab has no empty-state
   * copy to lie with, but without it the upload control invites a drop into a
   * list that has not loaded yet (CAR-205 review).
   */
  loading?: boolean;
  /** Takes the setter, not a plain callback: delete needs the functional
   *  updater to avoid writing a list it captured before the confirm dialog. */
  onAttachmentsChange: Dispatch<SetStateAction<Attachment[]>>;
  /**
   * Owned by the PAGE, not this component (the CAR-204 pattern, which the
   * CAR-207 review found this tab had not followed). This tab renders inside a
   * `SectionBoundary` whose key includes `dataGeneration`, so a `useConfirm`
   * living here is unmounted whenever a background refresh lands, and the open
   * dialog vanishes mid-question with nothing deleted and nothing said.
   */
  onConfirmDelete: () => Promise<boolean>;
}

export function ContactAttachmentsTab({ contactId, userId, attachments, loading = false, onAttachmentsChange, onConfirmDelete }: ContactAttachmentsTabProps) {
  const [uploading, setUploading] = useState(false);
  const { error: toastError } = useToast();
  const uploadingRef = useRef(false);
  // Per-id rather than one flag: each row deletes independently, and a shared
  // boolean would drop a second row's click while the first is in flight.
  const deletingRef = useRef(new Set<number>());

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    if (!input.files?.length) return;
    if (uploadingRef.current) return;
    uploadingRef.current = true;
    const files = Array.from(input.files);
    setUploading(true);
    try {
      // Two calls, because these are two different failures and one message
      // cannot honestly describe both. The refresh used to sit in a `finally`
      // INSIDE this action, and a `finally` that throws replaces the original
      // exception: a failed refresh after a fully successful upload was
      // reported as "couldn't upload", the list was left stale, and the
      // natural retry produced a duplicate storage object and row. When both
      // failed, the upload's own error was discarded entirely.
      const wrote = await withToastOnError(
        async () => {
          for (const file of files) {
            const attachment = await uploadAttachment(userId, file);
            await addAttachmentToContact(contactId, attachment.id);
          }
        },
        toastError,
        files.length > 1
          ? "Some files couldn't be uploaded. Please try again."
          : "Couldn't upload that file. Please try again.",
      );
      // Runs on both paths: a throw on file 3 of 5 still leaves 1 and 2
      // attached, and leaving those invisible until reload is the defect this
      // refresh exists to close.
      await withToastOnError(
        async () => onAttachmentsChange((await getAttachmentsForContact(contactId)) as Attachment[]),
        toastError,
        wrote
          ? "Your files uploaded, but the list couldn't be refreshed. Reload to see them."
          : "Couldn't refresh the attachment list. Reload to see what landed.",
      );
    } finally {
      uploadingRef.current = false;
      setUploading(false);
      input.value = "";
    }
  };

  // reentry-safe: a download writes nothing. It reads a signed URL and clicks a
  // synthetic anchor, so a second click costs one extra signature, not a second
  // mutation. It counts as a "mutation handler" to the guard only because
  // withToastOnError is on its always-mutating list.
  const handleDownload = async (objectPath: string, fileName: string) => {
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
      "Couldn't open that file. Please try again.",
    );
  };

  const handleDelete = async (attachmentId: number, objectPath: string) => {
    if (deletingRef.current.has(attachmentId)) return;
    deletingRef.current.add(attachmentId);
    try {
      // Unrecoverable: the storage object goes with the row, and no junction
      // cleanup can bring the file back. The question itself is asked by the
      // page, so a background refresh cannot unmount it mid-ask.
      if (!(await onConfirmDelete())) return;
      const ok = await withToastOnError(
        () => deleteAttachment(attachmentId, objectPath),
        toastError,
        "Couldn't delete that attachment. Please try again.",
      );
      if (!ok) return;
      // Functional updater rather than `attachments.filter(...)`: that prop is
      // captured at the render where the click happened, and the confirm
      // dialog stretches the gap to human decision time. An upload landing in
      // that gap was silently reverted, so a file the user had just added
      // disappeared from the list while sitting in the database.
      onAttachmentsChange((prev) => prev.filter((a) => a.id !== attachmentId));
    } finally {
      deletingRef.current.delete(attachmentId);
    }
  };

  const formatSize = (bytes: number | null) => {
    if (!bytes) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  };

  return (
    <div>
      <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2 mb-4">
        <Paperclip className="h-4 w-4" /> Attachments{attachments.length > 0 ? ` (${attachments.length})` : ""}
      </h4>

      {loading && (
        <div className="flex items-center gap-2.5 text-muted-foreground py-2">
          <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
          <span className="text-sm">Loading...</span>
        </div>
      )}

      {!loading && attachments.length > 0 && (
        <div className="space-y-2 mb-4">
          {attachments.map((att) => (
            <div key={att.id} className="flex items-center gap-2.5 text-base group">
              <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
              <button
                type="button"
                className="text-primary hover:underline truncate max-w-[200px] cursor-pointer text-left"
                onClick={() => handleDownload(att.object_path, att.file_name)}
              >
                {att.file_name}
              </button>
              {att.file_size_bytes && (
                <span className="text-sm text-muted-foreground">{formatSize(att.file_size_bytes)}</span>
              )}
              <button
                type="button"
                className="ml-auto opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all cursor-pointer"
                onClick={() => handleDelete(att.id, att.object_path)}
                title="Delete attachment"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      <label className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:text-primary/80 cursor-pointer transition-colors">
        <Plus className="h-4 w-4" />
        {uploading ? "Uploading…" : "Add file"}
        <input
          type="file"
          multiple
          className="hidden"
          onChange={handleUpload}
          disabled={uploading}
        />
      </label>
    </div>
  );
}
