"""Synthesize one narration clip per scene and record each clip's length.

    python narrate.py --mode demo|sandbox --out out/
Needs: pip install edge-tts imageio-ffmpeg  (Microsoft neural voices; synthetic narration,
disclosed in DEVPOST.md).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import subprocess
from pathlib import Path

import edge_tts
import imageio_ffmpeg

HERE = Path(__file__).resolve().parent


def duration(path: Path) -> float:
    err = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-i", str(path)],
                         capture_output=True, text=True).stderr
    h, m, s = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err).groups()
    return int(h) * 3600 + int(m) * 60 + float(s)


async def main(mode: str, out: Path) -> None:
    cfg = json.loads((HERE / "scenes.json").read_text(encoding="utf-8"))
    out.mkdir(parents=True, exist_ok=True)
    lengths = {}
    for sc in cfg["scenes"]:
        text = sc.get(f"say_{mode}") or sc["say"]
        clip = out / f"{sc['id']}.mp3"
        await edge_tts.Communicate(text, cfg["voice"], rate=cfg["rate"]).save(str(clip))
        lengths[sc["id"]] = round(duration(clip), 3)
    (out / "lengths.json").write_text(json.dumps(lengths, indent=1), encoding="utf-8")
    print(json.dumps({"total_s": round(sum(lengths.values()), 1), **lengths}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["demo", "sandbox"], default="demo")
    ap.add_argument("--out", type=Path, default=HERE / "out")
    a = ap.parse_args()
    asyncio.run(main(a.mode, a.out))
