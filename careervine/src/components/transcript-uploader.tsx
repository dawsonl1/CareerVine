"use client";

import { useState, useRef } from "react";
import { Upload, FileText, Mic, Loader2 } from "lucide-react";
import { parseTranscript, type TranscriptSegment } from "@/lib/transcript-parser";
import { inputClasses } from "@/lib/form-styles";

type TranscriptMode = "paste" | "file" | "audio";

interface TranscriptUploaderProps {
  /** Current raw transcript text (for paste mode / backward compat) */
  value: string;
  onChange: (value: string) => void;
  /** Called when segments are parsed (from any mode) */
  onSegmentsParsed?: (segments: TranscriptSegment[], source: string) => void;
  /** Called when an audio/video file is selected for transcription */
  onAudioFile?: (file: File) => void;
  /** Whether an audio transcription is in progress */
  isTranscribing?: boolean;
}

const AUDIO_ACCEPT = ".mp3,.m4a,.wav,.ogg,.flac,.mp4,.webm,.mov";
const TEXT_ACCEPT = ".txt,.vtt,.srt";

const tabStyle = (active: boolean) =>
  `flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-[6px] transition-colors cursor-pointer ${
    active
      ? "bg-primary text-on-primary"
      : "text-muted-foreground hover:bg-surface-container"
  }`;

export default function TranscriptUploader({
  value,
  onChange,
  onSegmentsParsed,
  onAudioFile,
  isTranscribing = false,
}: TranscriptUploaderProps) {
  const [mode, setMode] = useState<TranscriptMode>("paste");
  const [parseStatus, setParseStatus] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLInputElement>(null);

  // ── Paste mode ───────────────────────────────────────────
  const handlePasteChange = (text: string) => {
    onChange(text);
    // Auto-parse on paste if there's enough content
    if (text.length > 50) {
      const result = parseTranscript(text);
      if (result.segments.length > 0 && result.confidence >= 0.3) {
        setParseStatus(`Detected ${result.format} format — ${result.segments.length} segments, ${new Set(result.segments.map(s => s.speaker_label)).size} speakers`);
        onSegmentsParsed?.(result.segments, "paste");
      } else {
        setParseStatus(null);
      }
    } else {
      setParseStatus(null);
    }
  };

  // ── Text file upload ─────────────────────────────────────
  const handleTextFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const text = await file.text();
    onChange(text);

    const result = parseTranscript(text);
    const ext = file.name.split(".").pop()?.toLowerCase() || "txt";
    const source = `upload_${ext}`;

    if (result.segments.length > 0 && result.confidence >= 0.3) {
      setParseStatus(`Parsed ${result.segments.length} segments from ${file.name} (${result.format} format)`);
      onSegmentsParsed?.(result.segments, source);
    } else {
      // Try LLM fallback
      setParseStatus(`Parsing ${file.name} with AI...`);
      try {
        const res = await fetch("/api/transcripts/parse", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rawText: text }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.segments?.length > 0) {
            setParseStatus(`AI parsed ${data.segments.length} segments from ${file.name}`);
            onSegmentsParsed?.(data.segments, source);
          } else {
            setParseStatus(`Could not detect speakers in ${file.name}`);
          }
        } else {
          setParseStatus(`Could not parse ${file.name}`);
        }
      } catch {
        setParseStatus(`Could not parse ${file.name}`);
      }
    }

    // Reset input so same file can be re-selected
    e.target.value = "";
  };

  // ── Audio file upload ────────────────────────────────────
  const handleAudioFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setParseStatus(`Selected: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);
    onAudioFile?.(file);
    e.target.value = "";
  };

  return (
    <div className="space-y-2">
      {/* Mode tabs */}
      <div className="flex gap-1 p-1 bg-surface-container-low rounded-[8px]">
        <button type="button" className={tabStyle(mode === "paste")} onClick={() => setMode("paste")}>
          <FileText className="h-3.5 w-3.5" /> Paste
        </button>
        <button type="button" className={tabStyle(mode === "file")} onClick={() => setMode("file")}>
          <Upload className="h-3.5 w-3.5" /> Upload text
        </button>
        <button type="button" className={tabStyle(mode === "audio")} onClick={() => setMode("audio")}>
          <Mic className="h-3.5 w-3.5" /> Upload recording
        </button>
      </div>

      {/* Paste mode */}
      {mode === "paste" && (
        <textarea
          value={value}
          onChange={(e) => handlePasteChange(e.target.value)}
          className={`${inputClasses} !h-auto py-3`}
          rows={10}
          placeholder="Paste your full meeting transcript here..."
        />
      )}

      {/* Text file upload */}
      {mode === "file" && (
        <div>
          <input ref={fileRef} type="file" accept={TEXT_ACCEPT} onChange={handleTextFile} className="hidden" />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="w-full flex flex-col items-center justify-center gap-2 py-8 border-2 border-dashed border-outline rounded-[8px] text-muted-foreground hover:border-primary hover:text-primary transition-colors cursor-pointer"
          >
            <Upload className="h-6 w-6" />
            <span className="text-sm">Choose a transcript file</span>
            <span className="text-xs">.txt, .vtt, .srt</span>
          </button>
        </div>
      )}

      {/* Audio file upload */}
      {mode === "audio" && (
        <div>
          <input ref={audioRef} type="file" accept={AUDIO_ACCEPT} onChange={handleAudioFile} className="hidden" />
          {isTranscribing ? (
            <div className="w-full flex flex-col items-center justify-center gap-2 py-8 border-2 border-dashed border-primary/50 rounded-[8px] text-primary">
              <Loader2 className="h-6 w-6 animate-spin" />
              <span className="text-sm font-medium">Transcribing audio...</span>
              <span className="text-xs text-muted-foreground">This may take a minute depending on the file size</span>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => audioRef.current?.click()}
              className="w-full flex flex-col items-center justify-center gap-2 py-8 border-2 border-dashed border-outline rounded-[8px] text-muted-foreground hover:border-primary hover:text-primary transition-colors cursor-pointer"
            >
              <Mic className="h-6 w-6" />
              <span className="text-sm">Choose an audio or video file</span>
              <span className="text-xs">.mp3, .m4a, .wav, .mp4, .webm, .mov</span>
            </button>
          )}
        </div>
      )}

      {/* Parse status */}
      {parseStatus && (
        <p className="text-xs text-muted-foreground">{parseStatus}</p>
      )}
    </div>
  );
}
