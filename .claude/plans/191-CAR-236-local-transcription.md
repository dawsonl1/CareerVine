# CAR-236 — Local call transcription with CareerVine ingest

Bring the fully-local transcribe + diarize pipeline into the repo as supported tooling.
Proven end to end on 2026-08-06 against a real 19-minute Zoom call, which is now meeting 27
with 35 speaker-attributed segments.

## Why local at all

The audio path CareerVine already had (Deepgram, BYO key, CAR-30) was unreachable from the
UI — see CAR-237. So this is not replacing a working paid feature; it is filling a hole, and
doing it without an API key, a per-minute meter, or shipping a private call to a third party.

Measured on M3/24GB for a 19-minute call: ASR 75s (~15x realtime), diarization 5m52s (~3x
realtime), cost $0.

## Architecture

Three stages, each local:

| Stage | Tool | Where it lives |
|---|---|---|
| audio → text | whisper.cpp `large-v3-turbo` + Silero VAD | external binary, brew |
| who spoke when | sherpa-onnx: pyannote segmentation-3.0 + NeMo TitaNet | `diarize.py` (thin wrapper) |
| merge + attribute | pure data transformation | **`src/lib/transcript-merge.ts`** |
| speaker → contact | deterministic for a 1:1 call | `ingest.ts` |

**The merge logic goes in `src/lib/`, not in the script.** It is the only part with real
logic (overlap attribution, timestamp clamping, turn merging) and it is exactly the shape
Vitest tests well. Putting it under `src/lib/**` gets it type-checked by the `web` CI job,
covered by the coverage gate, and reusable if transcription ever moves into the browser.
`diarize.py` stays Python because sherpa-onnx is Python, but it is a thin wrapper with no
logic worth testing.

This needs `tsx` as a devDependency so the CLI can import the lib rather than duplicating it.
A second copy of the merge logic in `.mjs` would be the easier option and the wrong one: the
tested copy and the running copy must be the same code.

## Speaker identification is deterministic here

For a 1:1 networking call there are two voices, one is the user and one is the contact
already attached to the meeting. No LLM call, no content-guessing, no cost. The existing
AI matcher (`/api/transcripts/match-speakers`) stays for 3+ speakers.

Contact turns get `contact_id`; the user's turns stay unmapped, which is what the viewer
already expects (there is no "me" contact, and `TranscriptViewer` falls back to
`speaker_label`).

## Two findings that must stay encoded in the tooling

- **VAD is not optional.** Without it Whisper hallucinated a looping "Hey, uh..." across the
  3-minute Zoom waiting room at the head of the recording, and ran 53% slower.
- **Seed the decoder vocabulary.** Without `--prompt` carrying the contact and company name,
  "Brevium" came back as Bravium/Brandvium in 4 of 5 mentions.

Both belong in the driver script's defaults and comments, not in a README nobody rereads.

## Scope

- `src/lib/transcript-merge.ts` + tests — attribution by max overlap, clamping to the
  contiguous speech cluster, consecutive-turn merging, dropping cues with no speech under
  them, WebVTT emit.
- `scripts/local-transcribe/` — `transcribe-call` (bash driver), `diarize.py`, `install.sh`
  (fetch models), `ingest.ts` (CareerVine write), `README.md`.
- Ingest is dry-run by default, `--apply` to write, and refuses to double-ingest.

## Known limitation, documented not fixed

Short backchannels ("Sure.", "Okay.") sometimes merge into the adjacent long turn, because
attribution is per-ASR-segment and a segment can span a brief interjection. Turn-level
attribution is otherwise reliable. Fixing it properly needs word-level DTW timestamps; not
worth it for the networking-call use case.

## Verification

`npm run test`, `check:conventions`, `test:integration`, `build`. Every new test falsified by
reintroducing the bug it guards.
