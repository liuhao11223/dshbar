#!/usr/bin/env python3
"""DSHBar icon generator.

Draws a clean "ring + center dot" mark (echoing the task-countdown ring):
a gradient blue ring with a solid center dot on a transparent background.

Pure geometry, no emoji / no text.

Outputs (relative to project root when run from there):
  assets/icon.png           256x256 RGBA main icon
  assets/icon.ico           multi-size ico (16/32/48/256)
  assets/tray.ico           single-color tray icon (16/32)
  assets/trayTemplate.png   32x32 single-color tray icon

Requires Pillow (bundled with the DSH office runtime Python).
"""

from __future__ import annotations

import io
import math
import os
import struct
import sys
from typing import Iterable, List, Tuple

from PIL import Image, ImageDraw

# ---------------------------------------------------------------- palette ----
# Main icon: gradient from #4F8CFF (bright blue) to a deep blue.
GRAD_TOP: Tuple[int, int, int] = (79, 140, 255)    # #4F8CFF
GRAD_BOTTOM: Tuple[int, int, int] = (18, 42, 100)  # deep blue

# Tray icon: single colour, light enough to read on a dark taskbar.
TRAY_COLOR: Tuple[int, int, int] = (232, 236, 242)  # near-white / light grey


def _lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def _mix(c1: Tuple[int, int, int], c2: Tuple[int, int, int], t: float) -> Tuple[int, int, int]:
    return (
        int(round(_lerp(c1[0], c2[0], t))),
        int(round(_lerp(c1[1], c2[1], t))),
        int(round(_lerp(c1[2], c2[2], t))),
    )


def _smoothstep(edge0: float, edge1: float, x: float) -> float:
    if edge0 == edge1:
        return 0.0 if x < edge0 else 1.0
    t = (x - edge0) / (edge1 - edge0)
    t = max(0.0, min(1.0, t))
    return t * t * (3.0 - 2.0 * t)


def _sample_ring_pixel(x: float, y: float, cx: float, cy: float,
                       outer_r: float, inner_r: float, feather: float,
                       dot_r: float) -> Tuple[float, float, float, float]:
    """Return (r, g, b, a) for one ring+dot sample. a in [0, 1]."""
    dx = x - cx
    dy = y - cy
    dist = math.sqrt(dx * dx + dy * dy)

    # alpha coverage with a soft anti-alias band.
    ring_alpha = _smoothstep(inner_r - feather, inner_r + feather, dist) * \
        (1.0 - _smoothstep(outer_r - feather, outer_r + feather, dist))
    dot_alpha = 1.0 - _smoothstep(dot_r - feather, dot_r + feather, dist)

    # The ring is hollow: keep the band only OUTSIDE the dot (and its gap),
    # so punch out everything within the dot + gap radius.
    ring_alpha *= _smoothstep(dot_r + 4.0, dot_r + 8.0 + feather, dist)

    total_alpha = min(1.0, ring_alpha + dot_alpha)
    # diagonal gradient (top-left -> bottom-right) within the icon box
    t = (x + y) / (2.0 * max(1.0, outer_r * 2.0))
    t = max(0.0, min(1.0, t))
    color = _mix(GRAD_TOP, GRAD_BOTTOM, t)
    return (*color, total_alpha)


def build_ring_icon(size: int = 256, scale: int = 4,
                    dot_ratio: float = 0.26) -> Image.Image:
    """Build the main gradient ring icon at `size` (supersampled, LANCZOS)."""
    big = size * scale
    cx = cy = big / 2.0
    outer_r = (big / 2.0) * 0.905
    inner_r = outer_r - (22.0 / 256.0) * big          # 22 px stroke at 256
    dot_r = (size * dot_ratio) / 2.0 * scale           # solid center dot
    feather = max(1.5, big / 128.0)                    # ~2 px at final res

    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    px = canvas.load()
    for yy in range(big):
        for xx in range(big):
            r, g, b, a = _sample_ring_pixel(xx + 0.5, yy + 0.5, cx, cy,
                                            outer_r, inner_r, feather, dot_r)
            px[xx, yy] = (int(r), int(g), int(b), int(a * 255))

    return canvas.resize((size, size), Image.LANCZOS)


def build_tray_icon(size: int = 32, scale: int = 8) -> Image.Image:
    """Build the single-colour tray icon (light stroke, transparent bg)."""
    big = size * scale
    cx = cy = big / 2.0
    outer_r = (big / 2.0) * 0.90
    inner_r = outer_r - (2.6 / 32.0) * big
    dot_r = (big / 2.0) * 0.18
    feather = max(1.0, big / 96.0)

    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    px = canvas.load()
    for yy in range(big):
        for xx in range(big):
            dx = xx + 0.5 - cx
            dy = yy + 0.5 - cy
            dist = math.sqrt(dx * dx + dy * dy)
            ring_alpha = _smoothstep(inner_r - feather, inner_r + feather, dist) * \
                (1.0 - _smoothstep(outer_r - feather, outer_r + feather, dist))
            ring_alpha *= _smoothstep(dot_r + 1.0 * scale, dot_r + 2.0 * scale, dist)
            dot_alpha = 1.0 - _smoothstep(dot_r - feather, dot_r + feather, dist)
            a = min(1.0, ring_alpha + dot_alpha)
            px[xx, yy] = (TRAY_COLOR[0], TRAY_COLOR[1], TRAY_COLOR[2], int(a * 255))

    return canvas.resize((size, size), Image.LANCZOS)


# ------------------------------------------------------------ ICO helpers ----
def _png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _write_ico_png_frames(path: str, sizes: Iterable[int],
                          frames: List[Image.Image]) -> None:
    """Fallback ICO writer: composes PNG-compressed frames into an ICO.

    Windows Vista+ reads PNG-compressed ICO entries. This path is only used if
    Pillow's built-in .ico save fails.
    """
    entries = []
    blobs = []
    for img in frames:
        data = _png_bytes(img.convert("RGBA"))
        blobs.append(data)
        entries.append((img.width, img.height, len(data), 0))

    header = struct.pack("<HHH", 0, 1, len(entries))
    offset = len(header) + 16 * len(entries)
    body = bytearray()
    for (w, h, length, _), data in zip(entries, blobs):
        # width/height byte: 0 means 256
        bw = 0 if w >= 256 else w
        bh = 0 if h >= 256 else h
        body += struct.pack("<BBBBHHII", bw, bh, 0, 0, 1, 32, length, offset)
        offset += length
    for data in blobs:
        body += data

    with open(path, "wb") as fh:
        fh.write(header)
        fh.write(bytes(body))


def _ico_entry_count(path: str) -> int:
    """Number of image entries in a Windows .ico file."""
    with open(path, "rb") as fh:
        data = fh.read()
    if len(data) < 6:
        return 0
    return struct.unpack_from("<H", data, 4)[0]


def save_ico(path: str, frames: List[Image.Image]) -> None:
    """Save a valid multi-size Windows .ico.

    Pillow's ICO save only produces multiple entries when given a single base
    image plus `sizes` (it downscales the base). We therefore render every
    requested size from scratch but hand Pillow the largest frame as the base
    and the target `sizes` list. If Pillow fails or yields the wrong entry
    count we fall back to a manual PNG-ICO writer.
    """
    sizes = [(img.width, img.height) for img in frames]
    base = frames[-1]
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)

    ok = False
    try:
        base.save(path, format="ICO", sizes=sizes)
        ok = _ico_entry_count(path) == len(sizes)
    except Exception as exc:  # noqa: BLE001 - deliberate fallback
        print(f"  [warn] Pillow ICO failed ({exc}); using manual PNG-ICO writer")

    if not ok:
        print(f"  [warn] Pillow ICO entry count mismatch; using manual PNG-ICO writer")
        _write_ico_png_frames(path, [s[0] for s in sizes], frames)

    with Image.open(path) as chk:
        chk.load()
        print(f"  ok   {path}  entries={_ico_entry_count(path)} sizes={list(Image.open(path).info.get('sizes', []))}")


# ------------------------------------------------------------------ main -----
def main() -> int:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    assets = os.path.join(root, "assets")
    os.makedirs(assets, exist_ok=True)
    os.makedirs(os.path.join(root, "scripts"), exist_ok=True)

    print("DSHBar icon generation")
    print(f"  assets dir: {assets}")

    main_png = build_ring_icon(256)
    main_png.save(os.path.join(assets, "icon.png"))
    print("  ok   assets/icon.png  " + str(main_png.size))

    # icon.ico: 16 / 32 / 48 / 256
    frames = [build_ring_icon(s, scale=4) for s in (16, 32, 48, 256)]
    save_ico(os.path.join(assets, "icon.ico"), frames)

    # tray.ico: 16 / 32 single colour
    tray_frames = [build_tray_icon(s, scale=8) for s in (16, 32)]
    save_ico(os.path.join(assets, "tray.ico"), tray_frames)

    # trayTemplate.png: 32x32 single colour
    tray_png = build_tray_icon(32, scale=8)
    tray_png.save(os.path.join(assets, "trayTemplate.png"))
    print("  ok   assets/trayTemplate.png  " + str(tray_png.size))

    return 0


if __name__ == "__main__":
    sys.exit(main())