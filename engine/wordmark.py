"""Wortmarke für den Video-Export: Text als PNG; Bindestriche zwischen Buchstaben/Ziffern sitzen auf
der Höhe des F-Querbalkens statt tief wie der Font-Bindestrich (wirkt sonst wie ein Unterstrich).

Aufruf: python wordmark.py <text> <fontsize> <out.png> [hexcolor]
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

FONT_DIR = os.environ.get("INTERVIEW_FONT_DIR") or r"C:\Windows\Fonts"


def load_font(size):
    for name in ("bahnschrift.ttf", "segoeui.ttf", "arial.ttf", "DejaVuSans.ttf"):
        p = os.path.join(FONT_DIR, name)
        if os.path.isfile(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def f_bar(font, size):
    img = Image.new("L", (size * 2, size * 2), 0)
    d = ImageDraw.Draw(img)
    d.text((size // 4, 0), "F", font=font, fill=255)
    px = img.load()
    w, h = img.size
    rows = [sum(1 for x in range(w) if px[x, y] > 128) for y in range(h)]
    filled = [y for y, r in enumerate(rows) if r > 0]
    if not filled:
        return size * 0.45, max(2, size // 10)
    top, bottom = filled[0], filled[-1]
    stem = min(r for r in rows[top:bottom + 1] if r > 0)
    bars = [y for y in range(top, bottom + 1) if rows[y] > stem * 1.6]
    clusters = []
    for y in bars:
        if clusters and y - clusters[-1][-1] <= 1:
            clusters[-1].append(y)
        else:
            clusters.append([y])
    if len(clusters) >= 2:
        c = clusters[1]
        return (c[0] + c[-1]) / 2.0, max(2, len(c))
    return top + (bottom - top) * 0.47, max(2, stem)


def render(text, size, out, color="#00ff9f"):
    font = load_font(size)
    ascent, descent = font.getmetrics()
    bar_y, stroke = f_bar(font, size)
    dash_adv = font.getlength("-")
    width = int(font.getlength(text)) + 8
    img = Image.new("RGBA", (width, ascent + descent + 4), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    x = 2.0
    for i, ch in enumerate(text):
        raised = ch == "-" and 0 < i < len(text) - 1 and text[i - 1].isalnum() and text[i + 1].isalnum()
        if raised:
            pad = dash_adv * 0.14
            d.rectangle([x + pad, bar_y - stroke / 2.0, x + dash_adv - pad, bar_y + stroke / 2.0], fill=color)
            x += dash_adv
        else:
            d.text((x, 0), ch, font=font, fill=color)
            x += font.getlength(ch)
    img.save(out)
    print(f"{out} {img.size[0]}x{img.size[1]}")


if __name__ == "__main__":
    text, size, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    render(text, size, out, sys.argv[4] if len(sys.argv) > 4 else "#00ff9f")
