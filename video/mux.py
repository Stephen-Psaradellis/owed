"""Lay each narration clip at its scene's start and mux with the screen recording.

    python mux.py out/   ->  out/owed-demo.mp4
The video's first frames (page load) are trimmed: output starts 0.4s before scene 1.
A scene that overran its clip by more than CUT_OVER seconds (a slow live LLM or PayPal call)
has the quiet middle of that wait cut, keeping KEEP seconds each side; README says so.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg

out = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).with_name("out"))
cfg = json.loads(Path(__file__).with_name("scenes.json").read_text(encoding="utf-8"))
tl = json.loads((out / "timeline.json").read_text(encoding="utf-8"))
ids = [s["id"] for s in cfg["scenes"]]
lengths = json.loads((out / "lengths.json").read_text(encoding="utf-8"))
CUT_OVER, KEEP = 6.0, 2.5
lead = max(0.0, tl[ids[0]] - 0.4)
cuts = []  # (start, end) in seconds of the trimmed input
for i, nxt in zip(ids, ids[1:] + ["_end"]):
    if tl.get(f"{i}_overrun_s", 0) > CUT_OVER:
        a, b = tl[i] + lengths[i] + KEEP - lead, tl[nxt] - KEEP - lead
        if b - a > 1:
            cuts.append((a, b))
shift = lambda t: t - sum(b - a for a, b in cuts if b <= t)
end = shift(tl["_end"] - lead)

cmd = [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-ss", f"{lead:.3f}", "-i", str(out / "screen.webm")]
for i in ids:
    cmd += ["-i", str(out / f"{i}.mp3")]
parts, labels = [], []
for n, i in enumerate(ids, start=1):
    ms = int(round((shift(tl[i] - lead) + 0.25) * 1000))
    parts.append(f"[{n}:a]adelay={ms}|{ms}[a{n}]")
    labels.append(f"[a{n}]")
parts.append(f"{''.join(labels)}amix=inputs={len(ids)}:normalize=0,apad[aout]")
cut_expr = "+".join(f"between(t,{a:.3f},{b:.3f})" for a, b in cuts)
parts.append(f"[0:v]fps=30,select='not({cut_expr})',setpts=N/30/TB[vout]" if cuts else "[0:v]fps=30[vout]")
cmd += ["-filter_complex", ";".join(parts), "-map", "[vout]", "-map", "[aout]",
        "-t", f"{min(end, 179.0):.3f}", "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
        str(out / "owed-demo.mp4")]
r = subprocess.run(cmd, capture_output=True, text=True)
if r.returncode:
    sys.exit(r.stderr[-2000:])
print(json.dumps({"mp4": str(out / "owed-demo.mp4"), "seconds": round(min(end, 179.0), 1),
                  "cut_s": round(sum(b - a for a, b in cuts), 1)}))
