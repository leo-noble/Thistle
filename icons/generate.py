#!/usr/bin/env python3
"""Regenerate the Thistle icon set.

    python3 icons/generate.py

The mark is a usage gauge — the extension's signature feature — drawn as a
ring that runs gold to coral, wrapped around a Claude-style starburst. It
sits on the same velvet-noir tile the theme uses on claude.ai, so the
toolbar button matches the page it restyles.

Everything is drawn at 8x and downsampled with LANCZOS; Pillow has no
antialiased primitives, so supersampling is what keeps the arc edges clean.

The 16 and 32px variants are drawn from different numbers rather than
scaled down from the large one. At those sizes the starburst silts up into
a blob and the grey track is within a shade of the gold once antialiasing
has had its way with both, so the small build drops the centre mark and the
track entirely and thickens the arc into a bold crescent.
"""

import math

from PIL import Image, ImageDraw

# Palette, matching content/base.css.
TILE = (20, 20, 20, 255)  # --th-surface
EDGE = (46, 46, 46, 255)  # --th-line-2
TRACK = (46, 46, 46, 255)
GOLD = (212, 165, 116)  # gauge fill, 0% end
CORAL = (217, 119, 87)  # --th-accent, 100% end

SS = 8  # supersample factor

# Gauge geometry, as fractions of the canvas.
ARC_START = 130.0  # degrees, clockwise from 3 o'clock
ARC_SWEEP = 280.0  # leaves an open mouth at the bottom
ARC_FILLED = 0.72  # how much of the sweep is "used" — a full ring reads
#                    as a loading spinner, a partial one as a gauge


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def draw_arc(d, box, a0, a1, color, width):
    d.arc(box, a0, a1, fill=color, width=width)


def draw_cap(d, cx, cy, radius, angle, color, width):
    """Round cap. Pillow's arc() has butt ends, so caps are drawn as dots."""
    x = cx + radius * math.cos(math.radians(angle))
    y = cy + radius * math.sin(math.radians(angle))
    r = width / 2
    d.ellipse([x - r, y - r, x + r, y + r], fill=color)


def draw_starburst(d, cx, cy, length, half_width, rays, color):
    """Claude's asterisk: tapered rays meeting at the center."""
    for i in range(rays):
        angle = math.radians(i * 360.0 / rays - 90)
        perp = angle + math.pi / 2
        tip = (cx + length * math.cos(angle), cy + length * math.sin(angle))
        left = (cx + half_width * math.cos(perp), cy + half_width * math.sin(perp))
        right = (cx - half_width * math.cos(perp), cy - half_width * math.sin(perp))
        d.polygon([tip, left, right], fill=color)


def render(size, simple=False):
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Velvet-noir tile. The radius is squircle-ish rather than a soft
    # rounded rect — it reads correctly next to macOS and Chrome icons.
    d.rounded_rectangle(
        [0, 0, s - 1, s - 1],
        radius=int(s * 0.223),
        fill=TILE,
        outline=EDGE,
        width=max(1, int(s * 0.010)),
    )

    cx = cy = s / 2.0
    radius = s * (0.305 if not simple else 0.285)
    width = int(s * (0.076 if not simple else 0.135))
    box = [cx - radius, cy - radius, cx + radius, cy + radius]

    # Unused portion of the gauge. Omitted at 16px: the track and the fill
    # differ by one step of grey once antialiasing has had its way with
    # them, so all it contributes at that size is mud.
    if not simple:
        draw_arc(d, box, ARC_START, ARC_START + ARC_SWEEP, TRACK, width)
        draw_cap(d, cx, cy, radius, ARC_START, TRACK, width)
        draw_cap(d, cx, cy, radius, ARC_START + ARC_SWEEP, TRACK, width)

    # Used portion, gold -> coral. Pillow can't gradient a stroke, so the
    # arc is laid down in overlapping segments of interpolated colour; the
    # overlap hides the seams between them.
    end = ARC_START + ARC_SWEEP * ARC_FILLED
    steps = 160
    for i in range(steps):
        t = i / (steps - 1)
        a0 = ARC_START + (end - ARC_START) * i / steps
        a1 = ARC_START + (end - ARC_START) * (i + 1) / steps + 0.8
        draw_arc(d, box, a0, a1, lerp(GOLD, CORAL, t) + (255,), width)

    draw_cap(d, cx, cy, radius, ARC_START, GOLD + (255,), width)
    draw_cap(d, cx, cy, radius, end, CORAL + (255,), width)

    if simple:
        # No centre mark at 16px — the ring alone carries it. A dot inside
        # a ring this small closes up into a solid blob.
        pass
    else:
        draw_starburst(d, cx, cy, s * 0.150, s * 0.019, 8, CORAL + (255,))

    return img.resize((size, size), Image.LANCZOS)


def main():
    import os

    here = os.path.dirname(os.path.abspath(__file__))
    for size in (16, 32, 48, 128):
        path = os.path.join(here, f"icon{size}.png")
        render(size, simple=(size <= 32)).save(path)
        print("wrote", path)

    # Oversized copy for the README header and store listings.
    path = os.path.join(here, "logo512.png")
    render(512).save(path)
    print("wrote", path)


if __name__ == "__main__":
    main()
