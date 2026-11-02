"""Fetch and inspect the RickRoll GIF referenced by the user."""
from __future__ import annotations

import io
import json
import os
import urllib.request
from pathlib import Path
from PIL import Image, ImageDraw, ImageOps

URLS = [
    "https://c.tenor.com/3DOa1ly_iAUAAAAd/tenor.gif",
    "https://media.tenor.com/3DOa1ly_iAUAAAAd/tenor.gif",
    "https://media1.tenor.com/m/3DOa1ly_iAUAAAAd/tenor.gif",
]
dest = Path("public/rick-roll.gif")
dest.parent.mkdir(parents=True, exist_ok=True)
payload = None
last_error = None
for url in URLS:
    try:
        request = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (compatible; RickRollMemeGenerator/1.0)",
            "Accept": "image/gif,image/*;q=0.9,*/*;q=0.5",
        })
        with urllib.request.urlopen(request, timeout=35) as response:
            raw = response.read(25 * 1024 * 1024 + 1)
            if len(raw) > 25 * 1024 * 1024:
                raise RuntimeError("GIF exceeds 25MB")
            if raw[:6] not in (b"GIF89a", b"GIF87a"):
                raise RuntimeError(f"Not a GIF: {response.headers.get('Content-Type')}")
            payload = raw
            print(f"Downloaded {len(raw)} bytes from {url}")
            break
    except Exception as error:
        last_error = error
        print(f"Failed {url}: {error}")
if payload is None:
    raise RuntimeError(f"Unable to download exact requested GIF: {last_error}")

dest.write_bytes(payload)
im = Image.open(io.BytesIO(payload))
n = im.n_frames
delays_ms = []
disposals = []
durations = []
for i in range(n):
    im.seek(i)
    dur = im.info.get("duration", 100)
    delays_ms.append(int(dur))
    disposals.append(int(getattr(im, "disposal_method", 0)))
    durations.append(sum(delays_ms))

report = {
    "url": URLS[0],
    "file": str(dest),
    "width": im.width,
    "height": im.height,
    "frames": n,
    "durationMs": sum(delays_ms),
    "frameDelaysMs": delays_ms,
    "disposalMethods": disposals,
    "loop": im.info.get("loop", 1),
    "byteLength": len(payload),
}
Path("docs").mkdir(exist_ok=True)
Path("docs/rickroll-analysis.json").write_text(
    json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
)
# Contact sheets of up to 120 evenly spaced reference frames, numbered.
num = min(n, 120)
indices = sorted(set(round(j * (n - 1) / max(1, num - 1)) for j in range(num)))
cols = 8
cell_w, cell_h = 174, 148
rows = (len(indices) + cols - 1) // cols
sheet = Image.new("RGB", (cols * cell_w, rows * cell_h), "#202027")
draw = ImageDraw.Draw(sheet)
for j, idx in enumerate(indices):
    im.seek(idx)
    frame = im.convert("RGBA")
    frame.thumbnail((cell_w - 12, cell_h - 31), Image.Resampling.NEAREST)
    x = j % cols * cell_w
    y = j // cols * cell_h
    backing = Image.new("RGB", frame.size, "#888888")
    backing.paste(frame, (0, 0), frame)
    sheet.paste(backing, (x + (cell_w - frame.width) // 2, y + 2))
    draw.text((x + 5, y + cell_h - 23), f"F{idx:03d}  {durations[idx] / 1000:.2f}s", fill="#ffffff")
sheet.save("docs/rickroll-contact.jpg", quality=88, optimize=True)
print(json.dumps({k:v for k,v in report.items() if k not in ("frameDelaysMs","disposalMethods")}, indent=2))
