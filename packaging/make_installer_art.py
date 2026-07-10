"""Generate the themed Inno Setup wizard bitmaps for Rezident-Setup.exe.

    backend/.venv/Scripts/python.exe packaging/make_installer_art.py
-> packaging/wizard_large.bmp   (164x314, welcome/finish left panel)
-> packaging/wizard_small.bmp   (55x58, inner-page top-right)

Dark vault/terminal aesthetic: near-black with a faint phosphor grid, the
green "R" mark, the REZIDENT wordmark + tagline. BMP (24-bit) is what Inno wants.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
BG = (9, 11, 17)
GREEN = (62, 240, 158)
DIMGREEN = (26, 74, 56)
GRID = (18, 28, 28)
CREAM = (214, 220, 210)
FAINT = (120, 130, 128)


def _font(names, px):
    for n in names:
        try:
            return ImageFont.truetype("C:/Windows/Fonts/" + n, px)
        except OSError:
            continue
    return ImageFont.load_default()


def _mark(d, cx, cy, r, tile_edge=(34, 46, 50)):
    """The R-monogram tile, radius r, centered (cx,cy)."""
    d.rounded_rectangle([cx - r, cy - r, cx + r, cy + r], radius=int(r * 0.44),
                        fill=BG, outline=tile_edge, width=max(1, int(r * 0.06)))
    f = _font(["ariblk.ttf", "arialbd.ttf"], int(r * 1.5))
    b = d.textbbox((0, 0), "R", font=f)
    w, h = b[2] - b[0], b[3] - b[1]
    d.text((cx - w / 2 - b[0], cy - h / 2 - b[1] - r * 0.04), "R", font=f, fill=GREEN)


def _grid(d, w, h, step=18):
    for x in range(0, w, step):
        d.line([(x, 0), (x, h)], fill=GRID, width=1)
    for y in range(0, h, step):
        d.line([(0, y), (w, y)], fill=GRID, width=1)


def _fit_font(d, text, names, max_w, start_px):
    """Largest font (from names) whose `text` width fits within max_w."""
    px = start_px
    while px > 8:
        f = _font(names, px)
        b = d.textbbox((0, 0), text, font=f)
        if (b[2] - b[0]) <= max_w:
            return f
        px -= 2
    return _font(names, 8)


def _ctext(d, cx, y, text, font, fill):
    b = d.textbbox((0, 0), text, font=font)
    d.text((cx - (b[2] - b[0]) / 2 - b[0], y), text, font=font, fill=fill)
    return b[3] - b[1]  # height, so the caller can stack the next line


def large() -> Image.Image:
    ss = 3
    W, H = 164 * ss, 314 * ss
    margin = int(W * 0.10)
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    _grid(d, W, H, step=22 * ss)
    d.rectangle([0, 0, W, 4 * ss], fill=DIMGREEN)  # phosphor top edge
    # R mark, comfortably in the upper third
    _mark(d, W // 2, int(H * 0.30), int(W * 0.26))
    # wordmark: SCALE to fit within the margins so it never clips the edges
    wm = _fit_font(d, "REZIDENT", ["ariblk.ttf", "arialbd.ttf"], W - 2 * margin, int(W * 0.20))
    _ctext(d, W // 2, int(H * 0.52), "REZIDENT", wm, CREAM)
    # single tagline, clear gap below the wordmark (no overlap)
    tag = _fit_font(d, "self-hosted agent console", ["consola.ttf", "cour.ttf"], W - 2 * margin, int(W * 0.075))
    _ctext(d, W // 2, int(H * 0.62), "self-hosted agent console", tag, FAINT)
    # bottom caution ticks (a nod to the vault-industrial hazard stripe)
    for i in range(0, W, 26 * ss):
        d.rectangle([i, H - 8 * ss, i + 13 * ss, H - 4 * ss], fill=(60, 52, 20))
    return img.resize((164, 314), Image.LANCZOS)


def small() -> Image.Image:
    ss = 4
    W = H = 58 * ss
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    _mark(d, W // 2, H // 2, int(W * 0.40))
    return img.resize((55, 58), Image.LANCZOS)


large().save(HERE / "wizard_large.bmp", format="BMP")
small().save(HERE / "wizard_small.bmp", format="BMP")
print("wrote wizard_large.bmp (164x314), wizard_small.bmp (55x58)")
