"use client";

import { useRef, useState } from "react";
import { uploadAttachment, addAttachmentToContact, getAttachmentUrl, deleteAttachment, getAttachmentsForContact } from "@/lib/queries";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
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
  onAttachmentsChange: (attachments: Attachment[]) => void;
}

export function ContactAttachmentsTab({ contactId, userId, attachments, onAttachmentsChange }: ContactAttachmentsTabProps) {
  const [uploading, setUploading] = useState(false);
  const { error: toastError } = useToast();
  const { confirm, confirmDialog } = useConfirm();
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
      await withToastOnError(
        async () => {
          try {
            for (const file of files) {
              const attachment = await uploadAttachment(userId, file);
              await addAttachmentToContact(contactId, attachment.id);
            }
          } finally {
            // A throw on file 3 of 5 still leaves 1 and 2 attached, so the
            // refresh belongs on the failure path too. Without it the batch
            // that half-landed stayed invisible until the next page load.
            onAttachmentsChange((await getAttachmentsForContact(contactId)) as Attachment[]);
          }
        },
        toastError,
        files.length > 1
          ? "Some files couldn't be uploaded. Please try again."
          : "Couldn't upload that file. Please try again.",
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
      // cleanup can bring the file back.
      if (
        !(await confirm({
          message: "This permanently deletes the file. It cannot be undone.",
          title: "Delete attachment?",
          confirmLabel: "Delete",
          destructive: true,
        }))
      ) {
        return;
      }
      const ok = await withToastOnError(
        () => deleteAttachment(attachmentId, objectPath),
        toastError,
        "Couldn't delete that attachment. Please try again.",
      );
      if (!ok) return;
      onAttachmentsChange(attachments.filter((a) => a.id !== attachmentId));
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

      {attachments.length > 0 && (
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
      {confirmDialog}
    </div>
  );
}
