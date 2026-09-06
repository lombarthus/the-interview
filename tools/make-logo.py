"""Neutrales Logo für App, Video und Installer-Icon: dunkle Kachel, grünes Mikrofon.
Aufruf: python tools/make-logo.py  -> app/assets/logo.png (512x512) + app/assets/icon.ico"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "app" / "assets"
GREEN = (0, 255, 159)
BG = (5, 5, 5)


def draw(size: int) -> Image.Image:
    s = size
    img = Image.new("RGBA", (s, s), BG + (255,))
    d = ImageDraw.Draw(img)
    r = int(s * 0.12)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=r, fill=BG + (255,), outline=GREEN + (90,), width=max(2, s // 64))
    # Mikrofon: Kapsel, Bügel, Stiel, Fuß
    cx = s / 2
    cw, ch = s * 0.22, s * 0.40
    top = s * 0.16
    d.rounded_rectangle([cx - cw / 2, top, cx + cw / 2, top + ch], radius=cw / 2, fill=GREEN + (255,))
    for i in range(3):   # Gitterlinien
        y = top + ch * (0.30 + 0.18 * i)
        d.line([cx - cw / 2 + s * 0.03, y, cx + cw / 2 - s * 0.03, y], fill=BG + (200,), width=max(2, s // 90))
    bw = s * 0.42
    bt = top + ch * 0.55
    d.arc([cx - bw / 2, bt - bw * 0.15, cx + bw / 2, bt + bw * 0.55], start=0, end=180, fill=GREEN + (255,), width=max(3, s // 32))
    stem_top = bt + bw * 0.55
    d.line([cx, stem_top, cx, stem_top + s * 0.10], fill=GREEN + (255,), width=max(3, s // 32))
    d.line([cx - s * 0.12, stem_top + s * 0.10, cx + s * 0.12, stem_top + s * 0.10], fill=GREEN + (255,), width=max(3, s // 32))
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    draw(512).save(OUT / "logo.png")
    icons = [draw(n).convert("RGBA") for n in (256, 128, 64, 48, 32, 16)]
    icons[0].save(OUT / "icon.ico", format="ICO", sizes=[(i.width, i.height) for i in icons], append_images=icons[1:])
    print("logo.png + icon.ico geschrieben")


if __name__ == "__main__":
    main()
