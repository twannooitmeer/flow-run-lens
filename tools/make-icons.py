"""Writes the toolbar icons (a blue rounded square with green/red/green run dots)."""
import struct
import zlib
from pathlib import Path

BLUE = (15, 108, 189, 255)
DOTS = [(255, 255, 255, 255), (197, 15, 31, 255), (255, 255, 255, 255)]


def pixel(x, y, n):
    r = n * 0.2
    cx, cy = min(max(x, r), n - r), min(max(y, r), n - r)
    if (x - cx) ** 2 + (y - cy) ** 2 > r * r:
        return (0, 0, 0, 0)
    for i, colour in enumerate(DOTS):
        dx, dy = n * (0.25 + 0.25 * i), n * 0.5
        if (x - dx) ** 2 + (y - dy) ** 2 <= (n * 0.1) ** 2:
            return colour
    return BLUE


def png(n):
    rows = b"".join(b"\0" + b"".join(bytes(pixel(x + 0.5, y + 0.5, n)) for x in range(n)) for y in range(n))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


for size in (16, 48, 128):
    (Path(__file__).parent.parent / "icons" / f"icon{size}.png").write_bytes(png(size))
