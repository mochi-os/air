#!/usr/bin/env python3
# Copyright © 2026 Mochisoft OÜ
# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
"""Speak the cockpit voice alerts into web/src/assets/voice/.

Voice: Piper 2023.11.14-2 (MIT) with the en_US-ljspeech-high model from
rhasspy/piper-voices (MIT), trained on the LJ Speech dataset (public domain):
  https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ljspeech/high/en_US-ljspeech-high.onnx
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ljspeech/high/en_US-ljspeech-high.onnx.json

Usage: voice.py <piper directory> <model.onnx>
Needs bwrap, sox and ffmpeg. Piper is a downloaded binary, so it runs in
bubblewrap with no network and no view of $HOME. Each message is spoken twice,
as the jet's are (NATOPS A1-F18AC-NFM-000 2.17.3): the two sayings are voiced
separately, trimmed of silence and joined by a pause, then shaped as a headset
hears it - band-limited to 300-4800 Hz with a presence lift, then compressed -
limited like a radio channel so the words stand 4.5 dB louder at the same
peak, and packed as 16 kHz mono MP3, which every browser decodes.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

# The two sayings of each message, Piper's length scale (above 1 is slower) and
# the seconds of silence between the sayings.
MESSAGES = {
    "engine-fire-left": (("Engine fire left.", "Engine fire left."), 0.9, 0.32),
    "engine-fire-right": (("Engine fire right.", "Engine fire right."), 0.9, 0.32),
    "check-gear": (("Check gear.", "Check gear."), 0.9, 0.32),
    "flight-controls": (("Flight controls.", "Flight controls."), 0.9, 0.32),
    "engine-left": (("Engine left.", "Engine left."), 0.9, 0.32),
    "engine-right": (("Engine right.", "Engine right."), 0.9, 0.32),
    "fuel-low": (("Fuel low.", "Fuel low."), 0.9, 0.32),
    "bingo": (("Bingo,", "bingo."), 1.35, 0.55),   # said as a sentence the short word loses its "go"; the comma and the slower pace keep it
}
HEADSET = ["gain", "-8", "highpass", "300", "lowpass", "4800", "equalizer", "2500", "1q", "3",
           "compand", "0.01,0.20", "-60,-60,-30,-14,-20,-9,0,-5", "-3", "norm", "-1"]
LIMIT = ["compand", "0.002,0.06", "-40,-40,-18,-6,0,-1", "0", "-40", "0.004", "norm", "-1"]
TRIM = ["silence", "1", "0.01", "-50d", "reverse", "silence", "1", "0.01", "-50d", "reverse"]
PAD = ["pad", "0.03", "0.03"]

piper = Path(sys.argv[1]).resolve()
model = Path(sys.argv[2]).resolve()
out = Path(__file__).resolve().parent.parent / "web/src/assets/voice"
out.mkdir(exist_ok=True)

rate = json.loads(Path(f"{model}.json").read_text())["audio"]["sample_rate"]

def speak(text, target, scale, work):
    subprocess.run(["bwrap", "--ro-bind", "/", "/", "--tmpfs", "/home", "--tmpfs", "/tmp",
                    "--ro-bind", str(piper), str(piper), "--ro-bind", str(model.parent), str(model.parent),
                    "--bind", work, work, "--unshare-net", "--die-with-parent", "--chdir", work,
                    "env", f"LD_LIBRARY_PATH={piper}", str(piper / "piper"), "--model", str(model),
                    "--espeak_data", str(piper / "espeak-ng-data"), "--output_file", str(target),
                    "--length_scale", str(scale)],
                   input=text.encode(), check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

with tempfile.TemporaryDirectory() as work:
    for name, (sayings, scale, gap) in MESSAGES.items():
        pause = Path(work) / f"{name}-pause.wav"
        subprocess.run(["sox", "-n", "-r", str(rate), "-c", "1", str(pause), "trim", "0", str(gap)], check=True)
        pieces = []
        for index, text in enumerate(sayings):
            spoken = Path(work) / f"{name}-{index}.wav"
            speak(text, spoken, scale, work)
            trimmed = Path(work) / f"{name}-{index}-trimmed.wav"
            subprocess.run(["sox", str(spoken), str(trimmed), *TRIM], check=True)
            pieces += [str(trimmed), str(pause)]
        joined = Path(work) / f"{name}.wav"
        subprocess.run(["sox", *pieces[:-1], str(joined)], check=True)
        shaped = Path(work) / f"{name}-headset.wav"
        subprocess.run(["sox", str(joined), str(shaped), *PAD, *HEADSET, *LIMIT, "rate", "16000", "channels", "1"], check=True)
        target = out / f"{name}.mp3"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(shaped), "-c:a", "libmp3lame", "-b:a", "32k",
                        "-map_metadata", "-1", "-id3v2_version", "0", str(target)], check=True)
        print(f"{target.name} {target.stat().st_size} bytes")
