"""Textkarten für den Video-Export (eine PNG je Skriptzeile, 1280x720, transparent).

Grün umrissene Box mit halbtransparentem Hintergrund um den gesprochenen Text (weiß, fett,
zentriert), darüber an der Box-Kante der Sprecher — Host links (blau), Gast rechts (violett,
Vorname) — mit grünem Zähler; darunter die vorige Zeile gedimmt.

Aufruf: python cards.py <job.json> <outdir>
job.json: {"lines":[{"speaker":"Host"|"Guest","text":"..."}], "guest":"Vorname", "host":"Name"}
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 720
FONT_DIR = os.environ.get("INTERVIEW_FONT_DIR") or r"C:\Windows\Fonts"
GREEN = (0, 255, 159)
WHITE = (244, 244, 245)
GRAY = (200, 200, 208)
BLUE = (147, 197, 253)
PURPLE = (216, 180, 254)
BOX_X0, BOX_X1 = 90, 1190
PAD = 28
RADIUS = 18
HEADER_BOTTOM = 118
FOOTER_TOP = 700


def font(candidates, size):
    for name in candidates:
        p = os.path.join(FONT_DIR, name)
        if os.path.isfile(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def bold(size):
    return font(["segoeuib.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf"], size)


def label(size):
    return font(["bahnschrift.ttf", "segoeui.ttf", "arial.ttf", "DejaVuSans.ttf"], size)


def wrap(draw, text, fnt, max_w):
    words = text.split()
    lines, cur = [], ""
    for w in words:
        cand = (cur + " " + w).strip()
        if draw.textlength(cand, font=fnt) <= max_w or not cur:
            cur = cand
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def spaced(draw, xy, text, fnt, fill, spacing=3, anchor_right=False):
    widths = [draw.textlength(c, font=fnt) for c in text]
    total = sum(widths) + spacing * (len(text) - 1)
    x, y = xy
    if anchor_right:
        x -= total
    for c, cw in zip(text, widths):
        draw.text((x, y), c, font=fnt, fill=fill)
        x += cw + spacing
    return total


def render_card(idx, total, line, prev, guest, host, out):
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    size = 44
    while True:
        fnt = bold(size)
        lines = wrap(d, line["text"], fnt, BOX_X1 - BOX_X0 - 2 * PAD)
        lh = int(size * 1.28)
        box_h = len(lines) * lh + 2 * PAD
        if box_h <= FOOTER_TOP - HEADER_BOTTOM - 120 or size <= 28:
            break
        size -= 2
    cy = int(H * 0.55)
    top = cy - box_h // 2
    top = max(HEADER_BOTTOM + 44, min(top, FOOTER_TOP - 40 - box_h))
    bottom = top + box_h
    box = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    bd = ImageDraw.Draw(box)
    bd.rounded_rectangle([BOX_X0 - 3, top - 3, BOX_X1 + 3, bottom + 3], radius=RADIUS + 3, outline=GREEN + (70,), width=6)
    bd.rounded_rectangle([BOX_X0, top, BOX_X1, bottom], radius=RADIUS, fill=(0, 0, 0, 178), outline=GREEN + (230,), width=3)
    img.alpha_composite(box)
    y = top + PAD
    for ln in lines:
        tw = d.textlength(ln, font=fnt)
        d.text(((W - tw) / 2, y), ln, font=fnt, fill=WHITE + (255,))
        y += lh
    lfont = label(24)
    cfont = label(18)
    ly = top - 36
    counter = f"{idx + 1} / {total}"
    if line["speaker"] == "Host":
        w = spaced(d, (BOX_X0 + 2, ly), (host or "HOST").upper(), lfont, BLUE + (255,))
        d.text((BOX_X0 + 2 + w + 16, ly + 5), counter, font=cfont, fill=GREEN + (220,))
    else:
        name = (guest or "GAST").upper()
        spaced(d, (BOX_X1 - 2, ly), name, lfont, PURPLE + (255,), anchor_right=True)
        cw = d.textlength(counter, font=cfont)
        name_w = sum(d.textlength(c, font=lfont) for c in name) + 3 * (len(name) - 1)
        d.text((BOX_X1 - 2 - name_w - 16 - cw, ly + 5), counter, font=cfont, fill=GREEN + (220,))
    if prev:
        pfont = bold(22)
        plines = wrap(d, prev["text"], pfont, 1000)[:3]
        ph = len(plines) * 30
        py = bottom + 34
        if py + ph <= FOOTER_TOP:
            for ln in plines:
                tw = d.textlength(ln, font=pfont)
                d.text(((W - tw) / 2, py), ln, font=pfont, fill=GRAY + (150,))
                py += 30
    img.save(out)


def main():
    job = json.load(open(sys.argv[1], encoding="utf-8"))
    outdir = sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    lines = job["lines"]
    for i, line in enumerate(lines):
        render_card(i, len(lines), line, lines[i - 1] if i > 0 else None, job.get("guest"), job.get("host"), os.path.join(outdir, f"card{i}.png"))
    print(f"{len(lines)} cards")


if __name__ == "__main__":
    main()
