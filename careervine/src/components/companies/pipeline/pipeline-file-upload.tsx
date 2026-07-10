"use client";

import { useRef, useState } from "react";
import { FileText, Trash2, Upload } from "lucide-react";
import type { PipelineFileRef } from "@/lib/pipeline-state";
import {
  APPLICATION_PDF_MAX_BYTES,
  applicationPdfSignedUrl,
  deleteApplicationPdf,
  isApplicationPdf,
  uploadApplicationPdf,
} from "@/lib/pipeline-queries";

const inputClassName =
  "w-full h-9 px-3 rounded-md border border-outline-variant/50 bg-surface-container-high/50 text-sm text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
}

export function PipelinePdfUploadField({
  userId,
  file,
  onFileChange,
}: {
  userId: string;
  file: PipelineFileRef | null;
  onFileChange: (file: PipelineFileRef | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const handleFile = async (selected: File | null) => {
    setError(null);
    if (!selected) return;
    if (!isApplicationPdf(selected)) {
      setError("PDF only");
      return;
    }
    if (selected.size > APPLICATION_PDF_MAX_BYTES) {
      setError("Max 5 MB");
      return;
    }

    setUploading(true);
    try {
      const previous = file;
      const uploaded = await uploadApplicationPdf(userId, selected);
      onFileChange(uploaded);
      if (previous && previous.path !== uploaded.path) {
        await deleteApplicationPdf(previous.path);
      }
    } catch {
      setError("Could not save file");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const handleRemove = async () => {
    if (!file) return;
    const path = file.path;
    onFileChange(null);
    await deleteApplicationPdf(path);
  };

  const handleView = async () => {
    if (!file) return;
    try {
      const url = await applicationPdfSignedUrl(file.path);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      setError("Could not open file");
    }
  };

  if (file) {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2 min-h-9 px-2 rounded-md border border-outline-variant/50 bg-surface-container-high/50">
          <FileText className="w-4 h-4 text-primary shrink-0" aria-hidden />
          <button
            type="button"
            onClick={handleView}
            className="min-w-0 flex-1 text-left text-sm text-on-surface hover:text-primary truncate"
            title={file.name}
          >
            {file.name}
            <span className="text-on-surface-variant ml-1">({formatBytes(file.sizeBytes)})</span>
          </button>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="text-xs text-on-surface-variant hover:text-primary shrink-0"
          >
            Replace
          </button>
          <button
            type="button"
            onClick={handleRemove}
            aria-label="Remove PDF"
            className="p-1 rounded text-on-surface-variant/70 hover:text-error hover:bg-error-container/30 shrink-0"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="sr-only"
            onChange={(e) => void handleFile(e.target.files?.[0] ?? null)}
          />
        </div>
        {error && <p className="text-[11px] text-error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        className={`${inputClassName} inline-flex items-center justify-center gap-1.5 text-on-surface-variant hover:text-primary hover:border-primary/40 transition-colors disabled:opacity-60`}
      >
        <Upload className="w-3.5 h-3.5" />
        {uploading ? "Uploading…" : "Upload PDF"}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="sr-only"
        onChange={(e) => void handleFile(e.target.files?.[0] ?? null)}
      />
      {error && <p className="text-[11px] text-error">{error}</p>}
    </div>
  );
}
