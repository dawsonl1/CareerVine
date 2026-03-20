/**
 * Client-side transcript parser for common meeting transcript formats.
 *
 * Detects and parses transcripts from Zoom, Google Meet, MS Teams, Otter.ai,
 * VTT/SRT subtitle files, and generic "Speaker: text" formats.
 *
 * Pure functions — no React, no DB, fully testable.
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface ParsedTranscriptTurn {
  speaker_label: string;
  started_at: number | null;  // seconds from start
  ended_at: number | null;
  content: string;
}

export type TranscriptFormat =
  | "zoom" | "zoom-multiline" | "google-meet" | "teams"
  | "vtt" | "srt" | "generic" | "unknown";

export interface ParseResult {
  segments: ParsedTranscriptTurn[];
  format: TranscriptFormat;
  confidence: number; // 0–1
}

// ── Timestamp helpers ──────────────────────────────────────────────────

/** Parse HH:MM:SS or MM:SS to seconds */
function parseTimestamp(ts: string): number | null {
  const parts = ts.trim().split(":").map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

/** Parse VTT/SRT timestamp: MM:SS.mmm or HH:MM:SS.mmm to seconds */
function parseVttTimestamp(ts: string): number | null {
  // Split off milliseconds first (period or comma separator)
  const [timePart, msPart] = ts.trim().split(/[.,]/);
  const ms = msPart ? Number(msPart) / 1000 : 0;
  const secs = parseTimestamp(timePart);
  if (secs == null) return null;
  return secs + ms;
}

// ── Format detectors & parsers ─────────────────────────────────────────

/**
 * Zoom format:
 *   HH:MM:SS Speaker Name: text
 *   or
 *   HH:MM:SS  Speaker Name
 *   text line(s)
 */
function tryZoomTimestampFirst(text: string): ParseResult | null {
  // Pattern: timestamp at start of line, then speaker name with colon, then text
  const linePattern = /^(\d{1,2}:\d{2}(?::\d{2})?)\s+(.+?):\s*(.*)$/;
  const lines = text.split("\n");
  const segments: ParsedTranscriptTurn[] = [];
  let matched = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(linePattern);
    if (m) {
      matched++;
      segments.push({
        speaker_label: m[2].trim(),
        started_at: parseTimestamp(m[1]),
        ended_at: null,
        content: m[3].trim(),
      });
    } else if (segments.length > 0) {
      // Continuation line — append to previous segment
      segments[segments.length - 1].content += " " + trimmed;
    }
  }

  const nonEmpty = lines.filter((l) => l.trim()).length;
  if (matched < 2) return null;
  return { segments, format: "zoom", confidence: matched / nonEmpty };
}

/**
 * Zoom/Otter multi-line format:
 *   Speaker Name  HH:MM:SS
 *   text
 *   (blank line)
 */
function tryZoomMultiLine(text: string): ParseResult | null {
  const headerPattern = /^(.+?)\s{2,}(\d{1,2}:\d{2}(?::\d{2})?)\s*$/;
  const lines = text.split("\n");
  const segments: ParsedTranscriptTurn[] = [];
  let matched = 0;
  let current: ParsedTranscriptTurn | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const m = trimmed.match(headerPattern);
    if (m) {
      if (current) segments.push(current);
      matched++;
      current = {
        speaker_label: m[1].trim(),
        started_at: parseTimestamp(m[2]),
        ended_at: null,
        content: "",
      };
    } else if (current) {
      if (!trimmed) {
        segments.push(current);
        current = null;
      } else {
        current.content += (current.content ? " " : "") + trimmed;
      }
    }
  }
  if (current) segments.push(current);

  const nonEmpty = lines.filter((l) => l.trim()).length;
  if (matched < 2) return null;
  return { segments: segments.filter((s) => s.content), format: "zoom-multiline", confidence: matched / nonEmpty };
}

/**
 * Google Meet format:
 *   Speaker Name
 *   HH:MM:SS
 *   text
 */
function tryGoogleMeet(text: string): ParseResult | null {
  const lines = text.split("\n");
  const segments: ParsedTranscriptTurn[] = [];
  let matched = 0;
  const tsPattern = /^\d{1,2}:\d{2}(?::\d{2})?$/;

  let i = 0;
  while (i < lines.length) {
    const nameLine = lines[i]?.trim();
    const tsLine = lines[i + 1]?.trim();

    if (nameLine && tsLine && tsPattern.test(tsLine) && !tsPattern.test(nameLine)) {
      matched++;
      const contentLines: string[] = [];
      let j = i + 2;
      while (j < lines.length) {
        const next = lines[j]?.trim();
        // Check if next line + line after it form a new speaker+timestamp pair
        const nextTs = lines[j + 1]?.trim();
        if (next && nextTs && tsPattern.test(nextTs) && !tsPattern.test(next)) break;
        if (next === "") { j++; break; }
        contentLines.push(next);
        j++;
      }
      segments.push({
        speaker_label: nameLine,
        started_at: parseTimestamp(tsLine),
        ended_at: null,
        content: contentLines.join(" "),
      });
      i = j;
    } else {
      i++;
    }
  }

  const nonEmpty = lines.filter((l) => l.trim()).length;
  if (matched < 2) return null;
  return { segments: segments.filter((s) => s.content), format: "google-meet", confidence: matched / nonEmpty };
}

/**
 * MS Teams format:
 *   HH:MM:SS -- Speaker Name
 *   text
 */
function tryTeams(text: string): ParseResult | null {
  const headerPattern = /^(\d{1,2}:\d{2}(?::\d{2})?)\s*--\s*(.+)$/;
  const lines = text.split("\n");
  const segments: ParsedTranscriptTurn[] = [];
  let matched = 0;
  let current: ParsedTranscriptTurn | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const m = trimmed.match(headerPattern);
    if (m) {
      if (current) segments.push(current);
      matched++;
      current = {
        speaker_label: m[2].trim(),
        started_at: parseTimestamp(m[1]),
        ended_at: null,
        content: "",
      };
    } else if (current && trimmed) {
      current.content += (current.content ? " " : "") + trimmed;
    } else if (!trimmed && current) {
      segments.push(current);
      current = null;
    }
  }
  if (current) segments.push(current);

  const nonEmpty = lines.filter((l) => l.trim()).length;
  if (matched < 2) return null;
  return { segments: segments.filter((s) => s.content), format: "teams", confidence: matched / nonEmpty };
}

/**
 * WebVTT format with speaker tags:
 *   WEBVTT
 *
 *   00:00:01.000 --> 00:00:05.000
 *   <v Speaker Name>text</v>
 */
function tryVtt(text: string): ParseResult | null {
  if (!text.trim().startsWith("WEBVTT")) return null;

  const cuePattern = /^(\d{2}:\d{2}[:.]\d{3})\s*-->\s*(\d{2}:\d{2}[:.]\d{3})/;
  const speakerTag = /<v\s+([^>]+)>([\s\S]*?)(?:<\/v>)?$/;
  const lines = text.split("\n");
  const segments: ParsedTranscriptTurn[] = [];
  let matched = 0;

  let i = 0;
  while (i < lines.length) {
    const timeLine = lines[i]?.trim();
    const tm = timeLine?.match(cuePattern);
    if (tm) {
      matched++;
      const startSec = parseVttTimestamp(tm[1]);
      const endSec = parseVttTimestamp(tm[2]);
      // Collect content lines until blank
      const contentLines: string[] = [];
      i++;
      while (i < lines.length && lines[i]?.trim()) {
        contentLines.push(lines[i].trim());
        i++;
      }
      const fullContent = contentLines.join(" ");
      const sm = fullContent.match(speakerTag);
      if (sm) {
        segments.push({
          speaker_label: sm[1].trim(),
          started_at: startSec,
          ended_at: endSec,
          content: sm[2].trim(),
        });
      } else {
        segments.push({
          speaker_label: "Unknown",
          started_at: startSec,
          ended_at: endSec,
          content: fullContent,
        });
      }
    }
    i++;
  }

  if (matched < 1) return null;
  return { segments, format: "vtt", confidence: matched / Math.max(1, segments.length) };
}

/**
 * SRT format with optional speaker prefixes:
 *   1
 *   00:00:01,000 --> 00:00:05,000
 *   Speaker: text
 */
function trySrt(text: string): ParseResult | null {
  const cuePattern = /^(\d{2}:\d{2}:\d{2}),\d{3}\s*-->\s*(\d{2}:\d{2}:\d{2}),\d{3}/;
  const lines = text.split("\n");
  const segments: ParsedTranscriptTurn[] = [];
  let matched = 0;

  let i = 0;
  while (i < lines.length) {
    const timeLine = lines[i]?.trim();
    const tm = timeLine?.match(cuePattern);
    if (tm) {
      matched++;
      const startSec = parseTimestamp(tm[1]);
      const endSec = parseTimestamp(tm[2]);
      const contentLines: string[] = [];
      i++;
      while (i < lines.length && lines[i]?.trim()) {
        contentLines.push(lines[i].trim());
        i++;
      }
      const fullContent = contentLines.join(" ");
      // Check for "Speaker: text" prefix
      const speakerMatch = fullContent.match(/^([^:]{1,40}):\s+(.+)$/);
      if (speakerMatch) {
        segments.push({
          speaker_label: speakerMatch[1].trim(),
          started_at: startSec,
          ended_at: endSec,
          content: speakerMatch[2].trim(),
        });
      } else {
        segments.push({
          speaker_label: "Unknown",
          started_at: startSec,
          ended_at: endSec,
          content: fullContent,
        });
      }
    }
    i++;
  }

  if (matched < 1) return null;
  return { segments, format: "srt", confidence: matched / Math.max(1, segments.length) };
}

/**
 * Generic "Speaker: text" format (no timestamps)
 */
function tryGenericSpeaker(text: string): ParseResult | null {
  // Match lines like "Speaker Name: text here"
  // Speaker name: 1-40 chars, no digits at start, followed by colon and text
  const pattern = /^([A-Za-z][^:]{0,39}):\s+(.+)$/;
  const lines = text.split("\n");
  const segments: ParsedTranscriptTurn[] = [];
  let matched = 0;
  const speakers = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(pattern);
    if (m) {
      matched++;
      speakers.add(m[1].trim());
      segments.push({
        speaker_label: m[1].trim(),
        started_at: null,
        ended_at: null,
        content: m[2].trim(),
      });
    } else if (segments.length > 0) {
      // Continuation line
      segments[segments.length - 1].content += " " + trimmed;
    }
  }

  const nonEmpty = lines.filter((l) => l.trim()).length;
  // Need at least 2 speakers and reasonable match rate
  if (matched < 2 || speakers.size < 2) return null;
  return { segments, format: "generic", confidence: matched / nonEmpty };
}

// ── Main entry point ───────────────────────────────────────────────────

const parsers = [
  tryVtt,
  trySrt,
  tryTeams,
  tryZoomTimestampFirst,
  tryZoomMultiLine,
  tryGoogleMeet,
  tryGenericSpeaker,
];

/**
 * Parse a raw transcript string into structured speaker segments.
 *
 * Tries each known format in order and returns the first result with
 * confidence >= 0.3. Returns a low-confidence empty result if nothing matches.
 */
export function parseTranscript(rawText: string): ParseResult {
  if (!rawText?.trim()) {
    return { segments: [], format: "unknown", confidence: 0 };
  }

  for (const parser of parsers) {
    const result = parser(rawText);
    if (result && result.confidence >= 0.3 && result.segments.length >= 1) {
      // Merge consecutive segments from the same speaker
      const merged = mergeConsecutiveSpeakers(result.segments);
      return { ...result, segments: merged };
    }
  }

  return { segments: [], format: "unknown", confidence: 0 };
}

/**
 * Merge consecutive segments from the same speaker into one segment.
 * Preserves the first timestamp and takes the last end timestamp.
 */
function mergeConsecutiveSpeakers(segments: ParsedTranscriptTurn[]): ParsedTranscriptTurn[] {
  if (segments.length <= 1) return segments;
  const merged: ParsedTranscriptTurn[] = [{ ...segments[0] }];

  for (let i = 1; i < segments.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = segments[i];
    if (curr.speaker_label === prev.speaker_label) {
      prev.content += " " + curr.content;
      prev.ended_at = curr.ended_at ?? prev.ended_at;
    } else {
      merged.push({ ...curr });
    }
  }

  return merged;
}
