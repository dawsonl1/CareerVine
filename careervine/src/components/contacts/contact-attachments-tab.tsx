"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { uploadAttachment, addAttachmentToContact, getAttachmentUrl, deleteAttachment, getAttachmentsForContact } from "@/lib/queries";
import { Paperclip, Plus, Trash2, Download } from "lucide-react";

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

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(e.target.files)) {
        const attachment = await uploadAttachment(userId, file);
        await addAttachmentToContact(contactId, attachment.id);
      }
      const updated = await getAttachmentsForContact(contactId) as Attachment[];
      onAttachmentsChange(updated);
    } catch (err) {
      console.error("Error uploading attachment:", err);
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

  const handleDownload = async (objectPath: string, fileName: string) => {
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

  const handleDelete = async (attachmentId: number, objectPath: string) => {
    try {
      await deleteAttachment(attachmentId, objectPath);
      onAttachmentsChange(attachments.filter((a) => a.id !== attachmentId));
    } catch (err) {
      console.error("Error deleting attachment:", err);
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
                className="ml-auto opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-600 transition-all cursor-pointer"
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
