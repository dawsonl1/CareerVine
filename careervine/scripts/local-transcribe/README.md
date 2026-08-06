# Local call transcription

Turn a call recording into a CareerVine meeting with speaker-attributed transcript segments,
entirely on your own machine. No API key, no per-minute cost, and the audio never leaves the
laptop.

## Setup (once)

```bash
brew install whisper-cpp ffmpeg
careervine/scripts/local-transcribe/install.sh
```

Downloads ~1.7GB of models into `~/.local/share/local-transcribe` and builds the Python venv
sherpa-onnx needs. Safe to re-run.

## Use

```bash
scripts/local-transcribe/transcribe-call ~/Downloads/call.m4a \
  --speakers 2 \
  --names "Dawson Pitcher,Lance Johnson" \
  --prompt "Lance Johnson, Brevium, product management"
```

Writes `call.turns.json`, `call.vtt`, and `call.txt` beside the audio. Then:

```bash
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/local-transcribe/ingest.ts \
  --turns ~/Downloads/call.turns.json \
  --contact 350 \
  --date 2026-08-06T20:30:00Z \
  --title "Informational call with Lance Johnson (Brevium)" \
  --apply
```

Ingest is a dry run without `--apply`, and refuses to write a second locally-transcribed
meeting on the same day.

## What runs where

| Stage | Tool | Speed (M3, 19-min call) |
|---|---|---|
| audio → text | whisper.cpp `large-v3-turbo` + Silero VAD | 75s (~15x realtime) |
| who spoke when | sherpa-onnx: pyannote segmentation-3.0 + NeMo TitaNet | 5m52s (~3x realtime) |
| merge + attribute | [`src/lib/transcript-merge.ts`](../../src/lib/transcript-merge.ts) | instant |
| speaker → contact | deterministic (see below) | instant |

The merge logic lives in `src/lib/` on purpose: it is the only part with real logic, and there
it is unit-tested, type-checked, and covered by the coverage gate. `merge-cli.ts` is a thin
wrapper. **Do not reimplement merging in a script** — the tested copy and the running copy
must be the same code.

## Speaker identification needs no AI

A 1:1 networking call has two voices: you, and the contact already attached to the meeting.
`ingest.ts` maps the label matching the contact's name to their `contact_id` and leaves yours
unmapped, which is what `TranscriptViewer` already expects (there is no "me" contact, so it
falls back to the speaker label).

For 3+ speakers, pass `--speakers N`, leave the extra labels unmapped, and use the app's
existing AI matcher on the meeting.

## Two flags that are not optional

**`--vad`** (always on in the driver). Whisper hallucinates over silence. The call this was
built against opened with ~3 minutes of empty Zoom waiting room, and an unguarded run emitted
a looping "Hey, uh..." across the whole stretch. VAD also cut that run from 115s to 75s.

**`--prompt`**. Seeds the decoder's vocabulary. Without the contact and company name in it,
"Brevium" came back as *Bravium* / *Brandvium* in 4 of 5 mentions. Pass the names you expect
to hear.

## Known limitation

Short backchannels ("Sure.", "Okay.") sometimes merge into the adjacent long turn, because
attribution is per-ASR-segment and one segment can span a brief interjection. Turn-level
attribution is otherwise reliable. Fixing it properly needs word-level DTW timestamps, which
is not worth the run time for this use case.

## Gotcha if you touch install.sh

The sherpa-onnx speaker-embedding release tag is misspelled **upstream** as
`speaker-recongition-models`. The correctly-spelled URL 404s, and `curl` without `-f` happily
writes the 9-byte "Not Found" body as if it were the model.
