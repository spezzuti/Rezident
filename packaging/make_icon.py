"""Generate the Rezident window/taskbar/tray icon (multi-resolution .ico).

A bold phosphor-green "R" monogram on a dark rounded tile — designed to stay
legible at 16px (the old shield+keyhole+fat-border turned to mush small).

Run (Pillow required):
    backend/.venv/Scripts/python.exe packaging/make_icon.py
-> backend/desktop/assets/agentos.ico
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "backend" / "desktop" / "assets" / "agentos.ico"
OUT.parent.mkdir(parents=True, exist_ok=True)

BG = (9, 11, 17, 255)        # near-black tile
GREEN = (62, 240, 158, 255)  # phosphor green (the brand mark)
EDGE = (34, 46, 50, 255)     # subtle rim — NOT a fat green ring


def _font(px: int) -> ImageFont.FreeTypeFont:
    for name in ("ariblk.ttf", "arialbd.ttf", "seguisb.ttf"):
        try:
            return ImageFont.truetype("C:/Windows/Fonts/" + name, px)
        except OSError:
            continue
    return ImageFont.load_default()


def render(size: int) -> Image.Image:
    """Crisp per-size render via 4x supersampling."""
    ss = 4
    s = size * ss
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = max(1, round(s * 0.03))
    d.rounded_rectangle(
        [pad, pad, s - pad, s - pad],
        radius=round(s * 0.22), fill=BG, outline=EDGE, width=max(1, round(s * 0.012)),
    )
    f = _font(round(s * 0.74))
    b = d.textbbox((0, 0), "R", font=f)
    w, h = b[2] - b[0], b[3] - b[1]
    d.text((s / 2 - w / 2 - b[0], s / 2 - h / 2 - b[1] - s * 0.02), "R", font=f, fill=GREEN)
    return img.resize((size, size), Image.LANCZOS)


SIZES = [16, 24, 32, 48, 64, 128, 256]
base = render(256)
# PIL derives the smaller frames from the 256 render; the bold monogram
# downsamples cleanly (verified legible at 16px).
base.save(OUT, format="ICO", sizes=[(x, x) for x in SIZES])
print(f"wrote {OUT} ({', '.join(str(x) for x in SIZES)})")
