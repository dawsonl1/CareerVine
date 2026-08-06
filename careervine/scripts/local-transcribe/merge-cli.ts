/**
 * Merge whisper.cpp ASR output with sherpa-onnx diarization into attributed turns.
 *
 * Thin CLI over src/lib/transcript-merge.ts — all the rules live there, under
 * test. This file only reads files, calls the library, and writes files. Do not
 * reimplement merging logic here; the tested copy and the running copy must be
 * the same code.
 *
 *   node scripts/local-transcribe/merge-cli.ts \
 *     --asr asr.json --diarization diarization.json \
 *     --names "Dawson Pitcher,Lance Johnson" \
 *     --out-json turns.json --out-vtt transcript.vtt --out-txt transcript.txt
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  mergeTranscript,
  toWebVtt,
  toPlainText,
  wordCountBySpeaker,
  type AsrSegment,
  type DiarizationTurn,
} from "../../src/lib/transcript-merge.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function required(name: string): string {
  const v = arg(name);
  if (!v) {
    console.error(`missing --${name}`);
    process.exit(1);
  }
  return v;
}

/** whisper.cpp `-oj` output: offsets are milliseconds. */
interface WhisperJson {
  transcription?: Array<{
    text?: string;
    offsets?: { from?: number; to?: number };
  }>;
}

const whisper = JSON.parse(readFileSync(required("asr"), "utf8")) as WhisperJson;
const asr: AsrSegment[] = (whisper.transcription ?? [])
  .filter((s) => (s.text ?? "").trim().length > 0)
  .map((s) => ({
    start: (s.offsets?.from ?? 0) / 1000,
    end: (s.offsets?.to ?? 0) / 1000,
    text: (s.text ?? "").trim(),
  }));

const turns = JSON.parse(readFileSync(required("diarization"), "utf8")) as DiarizationTurn[];

const namesArg = arg("names");
const names = namesArg ? namesArg.split(",").map((n) => n.trim()) : undefined;

const merged = mergeTranscript(asr, turns, { names });

const outJson = arg("out-json");
const outVtt = arg("out-vtt");
const outTxt = arg("out-txt");
if (outJson) writeFileSync(outJson, `${JSON.stringify(merged, null, 2)}\n`);
if (outVtt) writeFileSync(outVtt, toWebVtt(merged));
if (outTxt) writeFileSync(outTxt, `${toPlainText(merged)}\n`);

const counts = wordCountBySpeaker(merged);
const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(`${merged.length} turns, ${total} words`);
for (const [label, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  const pct = total ? ((100 * n) / total).toFixed(1) : "0.0";
  console.log(`  ${label.padEnd(20)} ${String(n).padStart(5)} words (${pct}%)`);
}

if (merged.length === 0) {
  console.error("no turns produced — check that the diarization covers the audio");
  process.exit(1);
}
