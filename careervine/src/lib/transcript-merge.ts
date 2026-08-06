/**
 * Merge ASR segments with speaker-diarization turns into attributed transcript turns.
 *
 * This is the one piece of the local transcription pipeline (CAR-236) with real
 * logic, so it lives here rather than in the CLI: speech recognition and
 * diarization are separate models that each emit their own timeline, and
 * reconciling them is where the mistakes are. The CLI in
 * `scripts/local-transcribe/` imports this module; there is deliberately no
 * second copy of these rules in script form.
 *
 * Input timelines are independent:
 *   ASR   ──[ "thanks for making time"        ]──[ "happy to chat" ]──
 *   diar  ──[ speaker 0 ]──[ speaker 1 ]────────[ speaker 1 ]─────────
 *
 * Pure functions over plain data — no I/O, no model calls.
 */

/** One recognized span of speech, from whisper.cpp. Times are seconds. */
export interface AsrSegment {
  start: number;
  end: number;
  text: string;
}

/** One diarized span, from sherpa-onnx. `speaker` is a cluster index, not a name. */
export interface DiarizationTurn {
  start: number;
  end: number;
  speaker: number;
}

/** A merged, speaker-attributed turn, shaped for `transcript_segments`. */
export interface MergedTurn {
  ordinal: number;
  speakerLabel: string;
  speakerIndex: number;
  startedAt: number;
  endedAt: number;
  content: string;
}

export interface MergeOptions {
  /**
   * Display name per speaker index, e.g. `["Dawson Pitcher", "Lance Johnson"]`.
   * Indexes past the end fall back to `Speaker N`.
   */
  names?: string[];
  /**
   * Gap in seconds above which two turns by the same speaker are treated as
   * separate clusters when clamping. See `clampToSpeechCluster`.
   */
  maxClusterGap?: number;
}

const DEFAULT_MAX_CLUSTER_GAP = 5;

/** Total overlap between [start,end] and each speaker's turns, keyed by speaker index. */
export function overlapBySpeaker(
  start: number,
  end: number,
  turns: readonly DiarizationTurn[],
): Map<number, number> {
  const out = new Map<number, number>();
  for (const t of turns) {
    const overlap = Math.min(end, t.end) - Math.max(start, t.start);
    if (overlap > 0) out.set(t.speaker, (out.get(t.speaker) ?? 0) + overlap);
  }
  return out;
}

/**
 * Narrow [start,end] to where this speaker actually spoke inside it.
 *
 * VAD can stretch a single ASR cue across a long silence — on the call this was
 * built against, "Hey, Lance, how are you doing?" arrived as one cue spanning
 * 0:33 to 3:12 because the rest of that window was an empty Zoom waiting room.
 * A naive min/max clamp would faithfully report a six-word utterance as a
 * three-minute turn.
 *
 * So: group the speaker's overlapping turns into contiguous clusters, splitting
 * wherever they are more than `maxGap` apart, and keep only the cluster holding
 * the most overlap. Returns the input unchanged when the speaker has no turns
 * under the cue at all.
 */
export function clampToSpeechCluster(
  start: number,
  end: number,
  turns: readonly DiarizationTurn[],
  speaker: number,
  maxGap: number = DEFAULT_MAX_CLUSTER_GAP,
): { start: number; end: number } {
  const hits = turns
    .filter((t) => t.speaker === speaker && Math.min(end, t.end) > Math.max(start, t.start))
    .sort((a, b) => a.start - b.start);
  if (hits.length === 0) return { start, end };

  const clusters: DiarizationTurn[][] = [];
  let current: DiarizationTurn[] = [hits[0]];
  for (const t of hits.slice(1)) {
    if (t.start - current[current.length - 1].end > maxGap) {
      clusters.push(current);
      current = [t];
    } else {
      current.push(t);
    }
  }
  clusters.push(current);

  const weight = (cluster: DiarizationTurn[]) =>
    cluster.reduce((sum, t) => sum + (Math.min(end, t.end) - Math.max(start, t.start)), 0);

  let best = clusters[0];
  for (const c of clusters.slice(1)) if (weight(c) > weight(best)) best = c;

  return {
    start: Math.max(start, best[0].start),
    end: Math.min(end, best[best.length - 1].end),
  };
}

export function speakerLabel(index: number, names?: string[]): string {
  const name = names?.[index]?.trim();
  return name && name.length > 0 ? name : `Speaker ${index}`;
}

/**
 * Attribute each ASR segment to a speaker, then merge consecutive same-speaker
 * segments into conversational turns.
 *
 * Segments with no diarized speech under them are DROPPED, not attributed to a
 * nearest neighbour. That is load-bearing: Whisper hallucinates on silence
 * (looping "Hey, uh..." over a waiting room), and the diarizer's "nobody spoke
 * here" is the most reliable signal available for discarding it.
 */
export function mergeTranscript(
  asr: readonly AsrSegment[],
  turns: readonly DiarizationTurn[],
  options: MergeOptions = {},
): MergedTurn[] {
  const { names, maxClusterGap = DEFAULT_MAX_CLUSTER_GAP } = options;

  const attributed: Array<{ start: number; end: number; speaker: number; text: string }> = [];
  for (const seg of asr) {
    const text = seg.text.trim();
    if (!text) continue;

    const overlaps = overlapBySpeaker(seg.start, seg.end, turns);
    if (overlaps.size === 0) continue; // no speech under this cue

    let speaker = -1;
    let bestOverlap = -1;
    // Ties resolve to the lower speaker index, so the result is deterministic
    // rather than dependent on Map iteration order.
    for (const [candidate, amount] of [...overlaps].sort((a, b) => a[0] - b[0])) {
      if (amount > bestOverlap) {
        bestOverlap = amount;
        speaker = candidate;
      }
    }

    const clamped = clampToSpeechCluster(seg.start, seg.end, turns, speaker, maxClusterGap);
    attributed.push({ ...clamped, speaker, text });
  }

  attributed.sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: typeof attributed = [];
  for (const seg of attributed) {
    const last = merged[merged.length - 1];
    if (last && last.speaker === seg.speaker) {
      last.end = Math.max(last.end, seg.end);
      last.text += ` ${seg.text}`;
    } else {
      merged.push({ ...seg });
    }
  }

  return merged.map((t, i) => ({
    ordinal: i,
    speakerLabel: speakerLabel(t.speaker, names),
    speakerIndex: t.speaker,
    startedAt: round3(t.start),
    endedAt: round3(t.end),
    content: t.text.split(/\s+/).filter(Boolean).join(" "),
  }));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** `MM:SS.mmm`, or `HH:MM:SS.mmm` once past an hour. */
export function formatVttTimestamp(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  const ss = secs.toFixed(3).padStart(6, "0");
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${ss}`;
  }
  return `${String(minutes).padStart(2, "0")}:${ss}`;
}

/**
 * Render merged turns as WebVTT with `<v Speaker>` voice tags — the format
 * `transcript-parser.ts` reads with timestamps intact, so a locally-produced
 * transcript can also go in through the app's own "Upload text" tab.
 */
export function toWebVtt(turns: readonly MergedTurn[]): string {
  const cues = turns.map(
    (t) =>
      `${formatVttTimestamp(t.startedAt)} --> ${formatVttTimestamp(t.endedAt)}\n` +
      `<v ${t.speakerLabel}>${t.content}`,
  );
  return `WEBVTT\n\n${cues.join("\n\n")}${cues.length ? "\n" : ""}`;
}

/** Plain `Speaker: text` transcript, used for the meetings.transcript column. */
export function toPlainText(turns: readonly MergedTurn[]): string {
  return turns.map((t) => `${t.speakerLabel}: ${t.content}`).join("\n\n");
}

/** Words spoken per speaker label, for a quick sanity check on attribution. */
export function wordCountBySpeaker(turns: readonly MergedTurn[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of turns) {
    const words = t.content.split(/\s+/).filter(Boolean).length;
    out[t.speakerLabel] = (out[t.speakerLabel] ?? 0) + words;
  }
  return out;
}
