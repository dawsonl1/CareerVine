#!/usr/bin/env python3
"""Fully-local speaker diarization via sherpa-onnx (pyannote segmentation + TitaNet embeddings).

No network, no API key, no third-party service. Outputs JSON turns:
    [{"start": 1.23, "end": 4.56, "speaker": 0}, ...]
"""
import argparse
import json
import sys
import wave

import numpy as np
import sherpa_onnx


def read_wav_16k_mono(path):
    with wave.open(path, "rb") as w:
        if w.getnchannels() != 1:
            sys.exit(f"expected mono, got {w.getnchannels()} channels")
        if w.getsampwidth() != 2:
            sys.exit(f"expected 16-bit PCM, got {w.getsampwidth() * 8}-bit")
        rate = w.getframerate()
        if rate != 16000:
            sys.exit(f"expected 16000 Hz, got {rate}")
        raw = w.readframes(w.getnframes())
    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    return samples, rate


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", required=True)
    ap.add_argument("--segmentation", required=True)
    ap.add_argument("--embedding", required=True)
    ap.add_argument("--num-speakers", type=int, default=-1,
                    help="exact speaker count when known (e.g. 2 for a 1:1 call); -1 = auto")
    ap.add_argument("--threshold", type=float, default=0.5,
                    help="clustering threshold, used only when --num-speakers is -1")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    samples, rate = read_wav_16k_mono(args.wav)

    clustering = sherpa_onnx.FastClusteringConfig(
        num_clusters=args.num_speakers,
        threshold=args.threshold,
    )
    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                model=args.segmentation
            ),
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=args.embedding),
        clustering=clustering,
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    if not config.validate():
        sys.exit("invalid diarization config (check model paths)")

    sd = sherpa_onnx.OfflineSpeakerDiarization(config)
    if sd.sample_rate != rate:
        sys.exit(f"model wants {sd.sample_rate} Hz, wav is {rate} Hz")

    def progress(processed, total):
        if sys.stderr.isatty():
            pct = 100.0 * processed / total
            print(f"\rdiarizing… {pct:5.1f}%", end="", file=sys.stderr, flush=True)
        return 0

    result = sd.process(samples, callback=progress).sort_by_start_time()
    if sys.stderr.isatty():
        print(file=sys.stderr)

    turns = [
        {"start": round(s.start, 3), "end": round(s.end, 3), "speaker": s.speaker}
        for s in result
    ]
    with open(args.out, "w") as f:
        json.dump(turns, f, indent=2)

    speakers = sorted({t["speaker"] for t in turns})
    total = {sp: sum(t["end"] - t["start"] for t in turns if t["speaker"] == sp)
             for sp in speakers}
    print(f"{len(turns)} turns, {len(speakers)} speakers", file=sys.stdout)
    for sp in speakers:
        print(f"  speaker {sp}: {total[sp]:7.1f}s "
              f"({100 * total[sp] / sum(total.values()):.1f}%)")


if __name__ == "__main__":
    main()
