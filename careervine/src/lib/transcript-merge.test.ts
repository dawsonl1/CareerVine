import { describe, it, expect } from "vitest";
import {
  overlapBySpeaker,
  clampToSpeechCluster,
  speakerLabel,
  mergeTranscript,
  formatVttTimestamp,
  toWebVtt,
  toPlainText,
  wordCountBySpeaker,
  type AsrSegment,
  type DiarizationTurn,
} from "./transcript-merge";

const asr = (start: number, end: number, text: string): AsrSegment => ({ start, end, text });
const turn = (start: number, end: number, speaker: number): DiarizationTurn => ({
  start,
  end,
  speaker,
});

describe("overlapBySpeaker", () => {
  it("sums overlap per speaker across multiple turns", () => {
    const turns = [turn(0, 2, 0), turn(2, 5, 1), turn(5, 6, 0)];
    const out = overlapBySpeaker(1, 6, turns);
    expect(out.get(0)).toBe(2); // 1-2 plus 5-6
    expect(out.get(1)).toBe(3); // 2-5
  });

  it("ignores turns that only touch at a boundary", () => {
    expect(overlapBySpeaker(5, 10, [turn(0, 5, 0)]).size).toBe(0);
  });

  it("returns empty when nothing overlaps", () => {
    expect(overlapBySpeaker(20, 30, [turn(0, 5, 0)]).size).toBe(0);
  });
});

describe("clampToSpeechCluster", () => {
  it("keeps the busiest cluster when VAD stretches a cue across silence", () => {
    // The real case: one cue spanning 33.6 → 192.9 with a 158-second silent gap.
    // The utterance is at the start; the far end is a stray blip.
    const turns = [turn(33.6, 34.4, 0), turn(192.1, 192.4, 0)];
    const out = clampToSpeechCluster(33.6, 192.9, turns, 0);
    expect(out.start).toBeCloseTo(33.6, 3);
    expect(out.end).toBeCloseTo(34.4, 3);
  });

  it("picks the later cluster when that is where the speech is", () => {
    const turns = [turn(10, 10.2, 0), turn(60, 75, 0)];
    const out = clampToSpeechCluster(10, 80, turns, 0);
    expect(out.start).toBeCloseTo(60, 3);
    expect(out.end).toBeCloseTo(75, 3);
  });

  it("spans turns separated by less than the gap", () => {
    const turns = [turn(10, 12, 0), turn(14, 16, 0)];
    const out = clampToSpeechCluster(10, 20, turns, 0);
    expect(out.start).toBeCloseTo(10, 3);
    expect(out.end).toBeCloseTo(16, 3);
  });

  it("respects a custom gap threshold", () => {
    const turns = [turn(10, 12, 0), turn(20, 22, 0)];
    expect(clampToSpeechCluster(10, 30, turns, 0, 20).end).toBeCloseTo(22, 3);
    expect(clampToSpeechCluster(10, 30, turns, 0, 2).end).toBeCloseTo(12, 3);
  });

  it("ignores other speakers' turns", () => {
    const turns = [turn(0, 30, 1), turn(10, 12, 0)];
    const out = clampToSpeechCluster(0, 30, turns, 0);
    expect(out.start).toBeCloseTo(10, 3);
    expect(out.end).toBeCloseTo(12, 3);
  });

  it("returns the input unchanged when the speaker has no turns under the cue", () => {
    expect(clampToSpeechCluster(0, 5, [turn(90, 95, 1)], 0)).toEqual({ start: 0, end: 5 });
  });
});

describe("speakerLabel", () => {
  it("uses the supplied name", () => {
    expect(speakerLabel(1, ["Dawson", "Lance"])).toBe("Lance");
  });
  it("falls back past the end of the list", () => {
    expect(speakerLabel(2, ["Dawson", "Lance"])).toBe("Speaker 2");
  });
  it("falls back on a blank name rather than rendering an empty label", () => {
    expect(speakerLabel(0, ["   "])).toBe("Speaker 0");
  });
  it("falls back with no names at all", () => {
    expect(speakerLabel(0)).toBe("Speaker 0");
  });
});

describe("mergeTranscript", () => {
  it("attributes each segment to the speaker holding the most overlap", () => {
    const turns = [turn(0, 5, 0), turn(5, 10, 1)];
    const out = mergeTranscript(
      [asr(0, 4, "Thanks for making time."), asr(5.5, 9, "Happy to chat.")],
      turns,
      { names: ["Dawson", "Lance"] },
    );
    expect(out.map((t) => t.speakerLabel)).toEqual(["Dawson", "Lance"]);
    expect(out[0].content).toBe("Thanks for making time.");
    expect(out[1].content).toBe("Happy to chat.");
  });

  it("attributes a straddling segment to the dominant speaker", () => {
    // 1 second under speaker 0, 4 under speaker 1.
    const turns = [turn(0, 5, 0), turn(5, 12, 1)];
    const out = mergeTranscript([asr(4, 9, "mostly the second speaker")], turns);
    expect(out).toHaveLength(1);
    expect(out[0].speakerIndex).toBe(1);
  });

  it("drops cues with no diarized speech under them (Whisper silence hallucination)", () => {
    // The recording opened with ~3 minutes of empty Zoom waiting room, over
    // which Whisper emitted a looping "Hey, uh...". Diarization found no speech,
    // which is what makes those cues discardable.
    const turns = [turn(200, 210, 0)];
    const out = mergeTranscript(
      [
        asr(0, 30, "Hey, uh..."),
        asr(30, 60, "Hey, uh..."),
        asr(200, 208, "Real speech."),
      ],
      turns,
    );
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("Real speech.");
  });

  it("merges consecutive same-speaker segments into one turn", () => {
    const turns = [turn(0, 20, 0)];
    const out = mergeTranscript(
      [asr(0, 5, "One."), asr(5, 10, "Two."), asr(10, 15, "Three.")],
      turns,
    );
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("One. Two. Three.");
    expect(out[0].endedAt).toBeCloseTo(15, 3);
  });

  it("does not merge across a speaker change", () => {
    const turns = [turn(0, 5, 0), turn(5, 10, 1), turn(10, 15, 0)];
    const out = mergeTranscript(
      [asr(0, 4, "A."), asr(6, 9, "B."), asr(11, 14, "C.")],
      turns,
    );
    expect(out.map((t) => t.speakerIndex)).toEqual([0, 1, 0]);
  });

  it("numbers turns from zero in time order even when input is unsorted", () => {
    const turns = [turn(0, 5, 0), turn(5, 10, 1)];
    const out = mergeTranscript([asr(6, 9, "second"), asr(0, 4, "first")], turns);
    expect(out.map((t) => t.ordinal)).toEqual([0, 1]);
    expect(out[0].content).toBe("first");
  });

  it("skips blank and whitespace-only cues", () => {
    const turns = [turn(0, 10, 0)];
    const out = mergeTranscript([asr(0, 2, "   "), asr(3, 5, ""), asr(6, 8, "real")], turns);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("real");
  });

  it("collapses internal whitespace in merged content", () => {
    const turns = [turn(0, 10, 0)];
    const out = mergeTranscript([asr(0, 5, "  spaced   out  "), asr(5, 9, "text ")], turns);
    expect(out[0].content).toBe("spaced out text");
  });

  it("returns an empty list when there is no diarization at all", () => {
    expect(mergeTranscript([asr(0, 5, "hello")], [])).toEqual([]);
  });

  it("resolves an exact overlap tie deterministically to the lower index", () => {
    const turns = [turn(0, 5, 1), turn(5, 10, 0)];
    const a = mergeTranscript([asr(0, 10, "tied")], turns);
    const b = mergeTranscript([asr(0, 10, "tied")], [...turns].reverse());
    expect(a[0].speakerIndex).toBe(0);
    expect(b[0].speakerIndex).toBe(0);
  });
});

describe("formatVttTimestamp", () => {
  it("uses MM:SS.mmm under an hour", () => {
    expect(formatVttTimestamp(0)).toBe("00:00.000");
    expect(formatVttTimestamp(5.25)).toBe("00:05.250");
    expect(formatVttTimestamp(312.34)).toBe("05:12.340");
    expect(formatVttTimestamp(3599.999)).toBe("59:59.999");
  });

  it("switches to HH:MM:SS.mmm at an hour", () => {
    expect(formatVttTimestamp(3600)).toBe("01:00:00.000");
    expect(formatVttTimestamp(5025.678)).toBe("01:23:45.678");
  });

  it("clamps a negative time to zero", () => {
    expect(formatVttTimestamp(-1)).toBe("00:00.000");
  });
});

describe("toWebVtt", () => {
  it("emits voice-tagged cues", () => {
    const turns = mergeTranscript(
      [asr(0, 4, "Hello."), asr(6, 9, "Hi back.")],
      [turn(0, 5, 0), turn(5, 10, 1)],
      { names: ["Dawson", "Lance"] },
    );
    const vtt = toWebVtt(turns);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("<v Dawson>Hello.");
    expect(vtt).toContain("<v Lance>Hi back.");
    expect(vtt).toContain("-->");
  });

  it("emits a bare header for no turns", () => {
    expect(toWebVtt([])).toBe("WEBVTT\n\n");
  });
});

describe("toPlainText / wordCountBySpeaker", () => {
  const turns = mergeTranscript(
    [asr(0, 4, "one two three"), asr(6, 9, "four five")],
    [turn(0, 5, 0), turn(5, 10, 1)],
    { names: ["Dawson", "Lance"] },
  );

  it("renders Speaker: text blocks", () => {
    expect(toPlainText(turns)).toBe("Dawson: one two three\n\nLance: four five");
  });

  it("counts words per speaker", () => {
    expect(wordCountBySpeaker(turns)).toEqual({ Dawson: 3, Lance: 2 });
  });
});

describe("round trip against the app's own VTT parser", () => {
  it("produces VTT that parseTranscript reads back with speakers and timestamps", async () => {
    // The point of emitting VTT at all is that a locally-produced transcript can
    // go in through the app's existing "Upload text" tab. If these two ever
    // disagree on format, that path breaks silently — so assert the contract
    // against the real parser rather than a fixture.
    const { parseTranscript } = await import("./transcript-parser");

    const turns = mergeTranscript(
      [asr(0, 4, "Thanks for making time."), asr(3605, 3609, "An hour in.")],
      [turn(0, 5, 0), turn(3600, 3610, 1)],
      { names: ["Dawson Pitcher", "Lance Johnson"] },
    );

    const parsed = parseTranscript(toWebVtt(turns));
    expect(parsed.format).toBe("vtt");
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[0].speaker_label).toBe("Dawson Pitcher");
    expect(parsed.segments[1].speaker_label).toBe("Lance Johnson");
    expect(parsed.segments[1].started_at).toBeCloseTo(3605, 1);
  });
});
