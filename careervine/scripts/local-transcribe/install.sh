#!/usr/bin/env bash
# One-time setup for the local transcription pipeline (CAR-236).
# Fetches ~1.7GB of models into ~/.local/share/local-transcribe and builds the
# python venv sherpa-onnx needs. Safe to re-run; existing files are kept.
set -euo pipefail

DEST="${LOCAL_TRANSCRIBE_HOME:-$HOME/.local/share/local-transcribe}"
MODELS="$DEST/models"
VENV="$DEST/venv"
mkdir -p "$MODELS"

need() { command -v "$1" >/dev/null || { echo "missing $1 — run: brew install $2" >&2; exit 1; }; }
need ffmpeg ffmpeg
need whisper-cli whisper-cpp

fetch() { # url dest
  if [[ -s "$2" ]]; then echo "  have $(basename "$2")"; return; fi
  echo "  fetching $(basename "$2")…"
  curl -fsSL -o "$2" "$1"
}

echo "▸ speech recognition models"
fetch "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin" \
      "$MODELS/ggml-large-v3-turbo.bin"
fetch "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin" \
      "$MODELS/ggml-silero-v5.1.2.bin"

echo "▸ diarization models"
# NOTE: the speaker-embedding release tag is misspelled UPSTREAM as
# "speaker-recongition-models". The correctly-spelled URL 404s (and curl without
# -f writes a 9-byte "Not Found" body that looks like a successful download).
fetch "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_large.onnx" \
      "$MODELS/nemo_en_titanet_large.onnx"

if [[ ! -f "$MODELS/sherpa-onnx-pyannote-segmentation-3-0/model.onnx" ]]; then
  echo "  fetching pyannote segmentation…"
  curl -fsSL -o "$MODELS/seg.tar.bz2" \
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
  tar xjf "$MODELS/seg.tar.bz2" -C "$MODELS"
  rm -f "$MODELS/seg.tar.bz2"
else
  echo "  have pyannote segmentation"
fi

echo "▸ python venv (sherpa-onnx)"
# Deliberately sherpa-onnx rather than pyannote-on-HuggingFace: the upstream
# pyannote weights are gated behind a manual terms acceptance on huggingface.co,
# which no script can complete. These ONNX exports of the same models are not.
if [[ ! -x "$VENV/bin/python" ]]; then
  python3 -m venv "$VENV"
fi
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q sherpa-onnx numpy
"$VENV/bin/python" -c "import sherpa_onnx, numpy" || { echo "venv verification failed" >&2; exit 1; }

echo
echo "✓ installed to $DEST ($(du -sh "$DEST" | cut -f1))"
echo "  run: scripts/local-transcribe/transcribe-call <audio-file> --names \"You,Them\""
