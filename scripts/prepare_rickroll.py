"""Generate web-friendly 256px RickRoll GIF and detailed keyframe contact sheet.

The 640px, 287-frame original is kept unchanged at public/rick-roll.gif.
Every source frame is kept, and every delay stays 50 ms.
"""
from pathlib import Path
import json
from PIL import Image, ImageDraw, ImageOps

source = Path("public/rick-roll.gif")
info = json.loads(Path("docs/rickroll-analysis.json").read_text("utf-8"))
im = Image.open(source)
size = (256, 256)
frames = []
delays = []
keyframes = [55, 70, 82, 90, 94, 98, 100, 102, 104, 105, 106, 107, 108, 110, 120]
snapshots = {}
for i in range(im.n_frames):
    im.seek(i)
    rgba = im.convert("RGBA")
    if i in keyframes:
        snapshots[i] = rgba.copy()
    rgb = rgba.convert("RGB").resize(size, Image.Resampling.LANCZOS)
    # Per-frame color palette; original 640px reference remains available.
    frames.append(rgb.quantize(colors=192, method=Image.Quantize.MEDIANCUT))
    delays.append(info["frameDelaysMs"][i])
    if i % 60 == 0:
        print(f"Optimized {i}/{im.n_frames} frames")
target = Path("public/rick-roll-256.gif")
frames[0].save(target, save_all=True, append_images=frames[1:], optimize=True,
    duration=delays, loop=0, disposal=2)
check = Image.open(target)
assert check.n_frames == im.n_frames, (check.n_frames, im.n_frames)
assert sum(check.seek(i) or check.info["duration"] for i in range(check.n_frames)) == sum(delays)
print("Optimized GIF size:", target.stat().st_size)

# Enlarge reference keyframes for manual geometry calibration.
width, height, columns = 460, 500, 5
rows = (len(keyframes) + columns - 1) // columns
sheet = Image.new("RGB", (width * columns, height * rows), "#1c1c22")
draw = ImageDraw.Draw(sheet)
for j, idx in enumerate(keyframes):
    x = j % columns * width
    y = j // columns * height
    frame = snapshots[idx].convert("RGB")
    frame.thumbnail((440, 440), Image.Resampling.LANCZOS)
    sheet.paste(frame, (x + (width - frame.width) // 2, y + 8))
    draw.text((x + 10, y + 458), f"Frame {idx} at {sum(delays[:idx]) / 1000:.2f}s", fill="#ffffff")
sheet.save("docs/rickroll-keyframes.jpg", quality=90)
