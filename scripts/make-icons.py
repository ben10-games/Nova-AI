#!/usr/bin/env python3
"""Makes every Nova icon from the one logo (src/app/icon.svg: a violet-to-pink rounded square with a white
four-point star): the Chrome extension PNGs, Windows .ico, macOS .icns and the setup window's icons.
Run from the project folder: python3 scripts/make-icons.py   (needs Pillow)"""
import io
import os
import struct

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOP, BOTTOM = (0x8B, 0x9C, 0xFF), (0xD9, 0x46, 0xEF)  # the gradient of src/app/icon.svg
# The star of icon.svg on its 32x32 grid.
STAR = [(16, 6.5), (18.4, 13.6), (25.5, 16), (18.4, 18.4), (16, 25.5), (13.6, 18.4), (6.5, 16), (13.6, 13.6)]


def logo(size, margin=0.0):
    """The logo at `size` px; `margin` (share of the size) leaves room around it (macOS icon grid)."""
    big = size * 4  # drawn large, then scaled down for smooth edges
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    inner = big * (1 - 2 * margin)
    off = (big - inner) / 2
    # Diagonal gradient from top-left to bottom-right.
    grad = Image.new("RGBA", (big, big))
    px = grad.load()
    for y in range(big):
        for x in range(big):
            t = min(1.0, max(0.0, ((x - off) + (y - off)) / (2 * inner)))
            px[x, y] = tuple(int(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)) + (255,)
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle([off, off, off + inner, off + inner], radius=inner * 8 / 32, fill=255)
    img.paste(grad, (0, 0), mask)
    scale = inner / 32
    ImageDraw.Draw(img).polygon([(off + x * scale, off + y * scale) for x, y in STAR], fill=(255, 255, 255, 255))
    return img.resize((size, size), Image.LANCZOS)


def png_bytes(img):
    out = io.BytesIO()
    img.save(out, format="PNG", optimize=True)
    return out.getvalue()


def save(img, *parts):
    path = os.path.join(ROOT, *parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, format="PNG", optimize=True)
    return path


def write_ico(path, sizes):
    # ICO with PNG entries (Windows Vista and later).
    images = [png_bytes(logo(s)) for s in sizes]
    header = struct.pack("<HHH", 0, 1, len(sizes))
    entries, data, offset = b"", b"", 6 + 16 * len(sizes)
    for s, blob in zip(sizes, images):
        entries += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(blob), offset)
        data += blob
        offset += len(blob)
    with open(path, "wb") as f:
        f.write(header + entries + data)


def write_icns(path):
    # macOS icon: PNG entries; the artwork uses Apple's grid (about 10% margin, like other Mac apps).
    types = [(b"icp4", 16), (b"icp5", 32), (b"icp6", 64), (b"ic07", 128), (b"ic08", 256), (b"ic09", 512), (b"ic10", 1024)]
    body = b""
    for kind, s in types:
        blob = png_bytes(logo(s, margin=0.1))
        body += kind + struct.pack(">I", len(blob) + 8) + blob
    with open(path, "wb") as f:
        f.write(b"icns" + struct.pack(">I", len(body) + 8) + body)


if __name__ == "__main__":
    for s in (16, 32, 48, 128):
        save(logo(s), "chrome-extension", "icons", f"nova-{s}.png")
    save(logo(256), "setup", "assets", "nova-256.png")
    save(logo(512), "setup", "assets", "nova-512.png")
    write_ico(os.path.join(ROOT, "setup", "assets", "nova.ico"), [16, 24, 32, 48, 64, 128, 256])
    write_icns(os.path.join(ROOT, "setup", "assets", "nova.icns"))
    print("icons written")
