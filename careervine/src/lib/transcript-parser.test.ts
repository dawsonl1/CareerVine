import { describe, it, expect } from "vitest";
import { parseTranscript } from "./transcript-parser";

describe("parseTranscript", () => {
  it("returns empty result for empty input", () => {
    const result = parseTranscript("");
    expect(result.segments).toEqual([]);
    expect(result.format).toBe("unknown");
    expect(result.confidence).toBe(0);
  });

  it("returns empty result for null/undefined", () => {
    const result = parseTranscript(null as any);
    expect(result.segments).toEqual([]);
  });

  // ── Zoom timestamp-first format ───────────────────────────

  it("parses Zoom timestamp-first format", () => {
    const text = [
      "00:00:05 John Smith: Hello everyone, welcome to the meeting.",
      "00:00:12 Jane Doe: Thanks for having me, John.",
      "00:00:20 John Smith: Let's get started with the agenda.",
    ].join("\n");

    const result = parseTranscript(text);
    expect(result.format).toBe("zoom");
    expect(result.segments).toHaveLength(3);
    expect(result.segments[0].speaker_label).toBe("John Smith");
    expect(result.segments[0].started_at).toBe(5);
    expect(result.segments[0].content).toContain("Hello everyone");
    expect(result.segments[1].speaker_label).toBe("Jane Doe");
    expect(result.segments[1].started_at).toBe(12);
    expect(result.segments[2].speaker_label).toBe("John Smith");
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("parses Zoom format with HH:MM:SS timestamps", () => {
    const text = [
      "01:05:30 Alice: First point.",
      "01:06:00 Bob: Second point.",
    ].join("\n");

    const result = parseTranscript(text);
    expect(result.format).toBe("zoom");
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].started_at).toBe(3930); // 1*3600 + 5*60 + 30
  });

  // ── Zoom/Otter multi-line format ──────────────────────────

  it("parses Zoom/Otter multi-line format", () => {
    const text = [
      "John Smith  00:00:05",
      "Hello everyone, welcome to the meeting.",
      "",
      "Jane Doe  00:00:12",
      "Thanks for having me.",
      "",
      "John Smith  00:00:20",
      "Let's begin.",
    ].join("\n");

    const result = parseTranscript(text);
    expect(result.format).toBe("zoom-multiline");
    expect(result.segments).toHaveLength(3);
    expect(result.segments[0].speaker_label).toBe("John Smith");
    expect(result.segments[0].started_at).toBe(5);
    expect(result.segments[0].content).toBe("Hello everyone, welcome to the meeting.");
  });

  // ── Google Meet format ────────────────────────────────────

  it("parses Google Meet format", () => {
    const text = [
      "Alice Johnson",
      "0:05",
      "Hi everyone, glad to be here.",
      "",
      "Bob Wilson",
      "0:12",
      "Same here, Alice. Let's dive in.",
      "",
      "Alice Johnson",
      "0:20",
      "Sure thing. First item on the agenda.",
    ].join("\n");

    const result = parseTranscript(text);
    expect(result.format).toBe("google-meet");
    expect(result.segments).toHaveLength(3);
    expect(result.segments[0].speaker_label).toBe("Alice Johnson");
    expect(result.segments[0].started_at).toBe(5);
  });

  // ── MS Teams format ───────────────────────────────────────

  it("parses MS Teams format", () => {
    const text = [
      "00:00:05 -- Alice Johnson",
      "Hello, welcome to the Teams call.",
      "",
      "00:00:15 -- Bob Wilson",
      "Thanks Alice. I have some updates.",
      "",
      "00:00:30 -- Alice Johnson",
      "Great, go ahead.",
    ].join("\n");

    const result = parseTranscript(text);
    expect(result.format).toBe("teams");
    expect(result.segments).toHaveLength(3);
    expect(result.segments[0].speaker_label).toBe("Alice Johnson");
    expect(result.segments[0].started_at).toBe(5);
    expect(result.segments[1].speaker_label).toBe("Bob Wilson");
  });

  // ── VTT format ────────────────────────────────────────────

  it("parses VTT format with speaker tags", () => {
    const text = [
      "WEBVTT",
      "",
      "00:01.000 --> 00:05.000",
      "<v Alice>Hello, how are you?</v>",
      "",
      "00:05.000 --> 00:10.000",
      "<v Bob>I'm doing well, thanks!</v>",
    ].join("\n");

    const result = parseTranscript(text);
    expect(result.format).toBe("vtt");
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].speaker_label).toBe("Alice");
    expect(result.segments[0].content).toBe("Hello, how are you?");
    expect(result.segments[1].speaker_label).toBe("Bob");
  });

  it("parses VTT without speaker tags as Unknown", () => {
    const text = [
      "WEBVTT",
      "",
      "00:01.000 --> 00:05.000",
      "Hello, how are you?",
      "",
      "00:05.000 --> 00:10.000",
      "I'm doing well!",
    ].join("\n");

    const result = parseTranscript(text);
    expect(result.format).toBe("vtt");
    // Both segments have "Unknown" speaker, so they merge into one
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].speaker_label).toBe("Unknown");
    expect(result.segments[0].content).toContain("Hello");
    expect(result.segments[0].content).toContain("doing well");
  });

  // ── SRT format ────────────────────────────────────────────

  it("parses SRT format with speaker prefixes", () => {
    const text = [
      "1",
      "00:00:01,000 --> 00:00:05,000",
      "Alice: Hello everyone.",
      "",
      "2",
      "00:00:05,000 --> 00:00:10,000",
      "Bob: Hi Alice, nice to meet you.",
    ].join("\n");

    const result = parseTranscript(text);
    expect(result.format).toBe("srt");
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].speaker_label).toBe("Alice");
    expect(result.segments[0].started_at).toBe(1);
    expect(result.segments[0].ended_at).toBe(5);
  });

  // ── Generic "Speaker: text" format ────────────────────────

  it("parses generic speaker:text format", () => {
    const text = [
      "Alice: Hi Bob, how's the project going?",
      "Bob: It's going well. We hit our milestone.",
      "Alice: That's great to hear.",
      "Bob: Yeah, the team did a fantastic job.",
    ].join("\n");

    const result = parseTranscript(text);
    expect(result.format).toBe("generic");
    expect(result.segments).toHaveLength(4);
    expect(result.segments[0].speaker_label).toBe("Alice");
    expect(result.segments[0].started_at).toBeNull();
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("rejects generic format with only one speaker", () => {
    const text = [
      "Alice: Hi there.",
      "Alice: Just me talking.",
      "Alice: All alone.",
    ].join("\n");

    const result = parseTranscript(text);
    // Generic parser requires >= 2 speakers
    expect(result.format).toBe("unknown");
  });

  // ── Consecutive speaker merging ───────────────────────────

  it("merges consecutive segments from the same speaker", () => {
    const text = [
      "00:00:05 Alice: First thing.",
      "00:00:08 Alice: Second thing.",
      "00:00:15 Bob: My turn.",
      "00:00:20 Alice: Back to me.",
    ].join("\n");

    const result = parseTranscript(text);
    expect(result.segments).toHaveLength(3);
    expect(result.segments[0].speaker_label).toBe("Alice");
    expect(result.segments[0].content).toContain("First thing.");
    expect(result.segments[0].content).toContain("Second thing.");
    expect(result.segments[1].speaker_label).toBe("Bob");
    expect(result.segments[2].speaker_label).toBe("Alice");
  });

  // ── Continuation lines ────────────────────────────────────

  it("handles continuation lines in Zoom format", () => {
    const text = [
      "00:00:05 Alice: This is a long statement",
      "that continues on the next line.",
      "00:00:15 Bob: Got it.",
    ].join("\n");

    const result = parseTranscript(text);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].content).toContain("continues on the next line");
  });
});
