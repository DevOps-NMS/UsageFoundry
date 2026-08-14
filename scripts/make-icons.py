#!/usr/bin/env python3
"""Rasterise public/icon.svg into the PNG sizes an installed app needs.

An SVG is enough for a browser tab and enough for Chrome's install criteria,
but not for the two places that make this app feel installed: macOS "Add to
Dock" reads apple-touch-icon, and a maskable icon has to be drawn with the
platform's safe zone already in it. Both want raster.

Hand-rolled rather than pulled from a dependency because the mark is four
rounded rectangles and a vertical gradient — Pillow or a real SVG renderer
would be a build dependency for something zlib already does. Run it after
changing public/icon.svg; nothing runs it automatically, because the icon
changes about once.

    python3 scripts/make-icons.py
"""

import struct
import zlib
from pathlib import Path

PUBLIC = Path(__file__).resolve().parent.parent / "public"

# The geometry of public/icon.svg, in its own 32-unit viewBox.
TILE_TOP = (0x2B, 0x82, 0xE8)
TILE_BOTTOM = (0x0B, 0x6B, 0xCB)
TILE_RADIUS = 8.0
# x, y, width, height, corner radius — the three rising bars.
BARS = [(8.0, 18.0, 4.0, 7.0, 2.0), (14.0, 13.0, 4.0, 12.0, 2.0), (20.0, 7.0, 4.0, 18.0, 2.0)]
VIEWBOX = 32.0

# Supersampling factor. 4 means 16 samples per pixel, which is enough for a
# hairline-free edge at 180px and costs nothing at these sizes.
SAMPLES = 4


def covers_rounded_rect(px, py, x, y, w, h, r):
    """Is (px, py) inside the rounded rectangle?"""
    if px < x or px > x + w or py < y or py > y + h:
        return False
    # Only the four corner squares can be outside; everything else is inside.
    cx = x + r if px < x + r else (x + w - r if px > x + w - r else px)
    cy = y + r if py < y + r else (y + h - r if py > y + h - r else py)
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r


def render(size, radius, bar_scale):
    """One RGBA image, as a list of rows of (r, g, b, a) tuples.

    `radius` is in viewBox units, so 0 gives the full-bleed square Apple masks
    itself. `bar_scale` shrinks the mark about the centre for a maskable icon,
    whose outer 20% can be cropped to any shape the platform likes.
    """
    unit = VIEWBOX / size
    step = unit / SAMPLES
    offset = step / 2
    centre = VIEWBOX / 2
    rows = []
    for py in range(size):
        row = []
        for px in range(size):
            tile_hits = 0
            bar_hits = 0
            for sy in range(SAMPLES):
                vy = (py * SAMPLES + sy) * step + offset
                for sx in range(SAMPLES):
                    vx = (px * SAMPLES + sx) * step + offset
                    if not covers_rounded_rect(vx, vy, 0, 0, VIEWBOX, VIEWBOX, radius):
                        continue
                    tile_hits += 1
                    # The bar test runs in unscaled space, so the sample is
                    # mapped back through the scale rather than the bars
                    # forward through it.
                    bx = centre + (vx - centre) / bar_scale
                    by = centre + (vy - centre) / bar_scale
                    if any(covers_rounded_rect(bx, by, *bar) for bar in BARS):
                        bar_hits += 1
            total = SAMPLES * SAMPLES
            if tile_hits == 0:
                row.append((0, 0, 0, 0))
                continue
            # The gradient runs top to bottom across the whole tile.
            t = (py + 0.5) / size
            tile = tuple(
                round(TILE_TOP[i] + (TILE_BOTTOM[i] - TILE_TOP[i]) * t) for i in range(3)
            )
            bar_share = bar_hits / tile_hits
            colour = tuple(round(tile[i] + (255 - tile[i]) * bar_share) for i in range(3))
            row.append((*colour, round(255 * tile_hits / total)))
        rows.append(row)
    return rows


def write_png(path, rows):
    size = len(rows)
    raw = bytearray()
    for row in rows:
        raw.append(0)  # filter type 0 (None) — these images compress fine flat
        for pixel in row:
            raw.extend(pixel)

    def chunk(kind, payload):
        head = struct.pack(">I", len(payload)) + kind
        return head + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)
    print(f"{path.name}: {size}×{size}, {len(png)} bytes")


def main():
    write_png(PUBLIC / "icon-192.png", render(192, TILE_RADIUS, 1.0))
    write_png(PUBLIC / "icon-512.png", render(512, TILE_RADIUS, 1.0))
    # Maskable: the tile fills the square and the mark shrinks into the safe
    # zone, so a circular or squircular crop takes only background.
    write_png(PUBLIC / "icon-maskable-512.png", render(512, 0.0, 0.62))
    # Apple masks the corners itself, so this one is square and full bleed.
    write_png(PUBLIC / "apple-touch-icon.png", render(180, 0.0, 1.0))


if __name__ == "__main__":
    main()
