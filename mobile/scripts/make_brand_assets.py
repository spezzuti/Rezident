"""Generate the Rezident Android brand assets (launcher icon + splash sources).

Mirrors the desktop icon in packaging/make_icon.py: a bold phosphor-green "R"
monogram on a near-black rounded tile. These PNGs are the *source* images fed to
`@capacitor/assets`, which fans them out to every Android density.

Run (Pillow required — the backend venv has it):
    backend/.venv/Scripts/python.exe mobile/scripts/make_brand_assets.py

Then generate the native resources:
    cd mobile && npx capacitor-assets generate --android \
        --iconBackgroundColor '#090B11' --iconBackgroundColorDark '#090B11' \
        --splashBackgroundColor '#090B11' --splashBackgroundColorDark '#090B11'

Then add the Android-13 themed (monochrome) layer + patch the adaptive XML:
    backend/.venv/Scripts/python.exe mobile/scripts/make_brand_assets.py --monochrome

Outputs (mobile/assets/):
    icon-foreground.png  1024  green R only, transparent, safe-zone padded
    icon-background.png  1024  near-black #090B11 with a subtle radial center
    icon-only.png        1024  full rounded tile + rim + R (legacy/store icon)
    icon.png             1024  alias of icon-only.png (deliverable name)
    splash.png           2732  centered R on #090B11, generous margin
    splash-dark.png      2732  identical (brand is already dark)
    icon-monochrome.png  1024  white R only, transparent (themed-icon reference)
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# --- Brand palette (identical to packaging/make_icon.py) --------------------
BG = (9, 11, 17)          # #090B11  near-black tile
BG_CENTER = (18, 22, 27)  # #12161B  subtle lift at the icon-background center
GREEN = (62, 240, 158)    # #3EF09E  phosphor green (the brand mark)
EDGE = (34, 46, 50)       # #222E32  subtle rim — NOT a fat green ring
WHITE = (255, 255, 255)   # monochrome (themed) layer — system tints it

HERE = Path(__file__).resolve().parent
MOBILE = HERE.parent
ASSETS = MOBILE / "assets"
RES = MOBILE / "android" / "app" / "src" / "main" / "res"

# Adaptive foreground safe zone. The system masks the outer ~1/6 of each side
# and the mask shape varies (circle/squircle/rounded). We scale the R so its
# *circumscribed circle* (the worst case for a circle mask — the R's bbox
# corners are its farthest points) fits inside 60% of the canvas diameter,
# comfortably within the 66 dp (0.611 of 108 dp) guaranteed-safe circle.
FG_SAFE_DIAM = 0.60
# The legacy tile is never masked, so the R can fill it like the desktop icon.
TILE_R_HEIGHT = 0.52
# The splash is center-cropped across many aspect ratios → keep lots of margin.
SPLASH_R_HEIGHT = 0.22


def _font(px: int) -> ImageFont.FreeTypeFont:
    for name in ("ariblk.ttf", "arialbd.ttf", "seguisb.ttf"):
        try:
            return ImageFont.truetype("C:/Windows/Fonts/" + name, px)
        except OSError:
            continue
    return ImageFont.load_default()


def _r_glyph(color: tuple[int, int, int]) -> Image.Image:
    """Render a tight-cropped, opaque "R" in `color` at high resolution.

    Rendered big (1600 px em) then downscaled by the callers, so every final
    placement is a LANCZOS *downsample* → crisp edges at any target size.
    """
    px = 1600
    f = _font(px)
    probe = ImageDraw.Draw(Image.new("RGBA", (px * 2, px * 2)))
    l, t, r, b = probe.textbbox((0, 0), "R", font=f)
    w, h = r - l, b - t
    glyph = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(glyph).text((-l, -t), "R", font=f, fill=color + (255,))
    return glyph


def _paste_r(
    canvas: Image.Image,
    glyph: Image.Image,
    *,
    diam_frac: float | None = None,
    height_frac: float | None = None,
    dy_frac: float = 0.0,
) -> None:
    """Scale `glyph` and paste it centered on `canvas`.

    diam_frac  — fit the glyph's circumscribed circle to this fraction of the
                 canvas (masking-safe sizing for adaptive foregrounds).
    height_frac — fit the glyph's height to this fraction of the canvas.
    dy_frac    — optical vertical nudge (negative = up), fraction of canvas.
    """
    S = canvas.size[0]
    w, h = glyph.size
    if diam_frac is not None:
        target = diam_frac * S
        scale = target / (w**2 + h**2) ** 0.5
    else:
        assert height_frac is not None
        scale = (height_frac * S) / h
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    g = glyph.resize((nw, nh), Image.LANCZOS)
    x = round((S - nw) / 2)
    y = round((S - nh) / 2 + dy_frac * S)
    canvas.alpha_composite(g, (x, y))


def _radial_bg(S: int) -> Image.Image:
    """Solid #090B11 with a very subtle radial lift toward #12161B at center."""
    try:
        import numpy as np

        yy, xx = np.mgrid[0:S, 0:S].astype("float32")
        c = (S - 1) / 2.0
        r = np.sqrt((xx - c) ** 2 + (yy - c) ** 2) / (S * 0.62)
        r = np.clip(r, 0.0, 1.0)
        t = r * r * (3 - 2 * r)  # smoothstep: 0 at center → 1 at edge
        out = np.empty((S, S, 3), "float32")
        for i in range(3):
            out[..., i] = BG_CENTER[i] * (1 - t) + BG[i] * t
        arr = np.dstack([out.round().astype("uint8"),
                         np.full((S, S), 255, "uint8")])
        return Image.fromarray(arr, "RGBA")
    except Exception:
        return Image.new("RGBA", (S, S), BG + (255,))


def _tile(S: int) -> Image.Image:
    """Rounded near-black tile + subtle rim (mirrors make_icon.render)."""
    ss = 2
    s = S * ss
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = max(1, round(s * 0.03))
    d.rounded_rectangle(
        [pad, pad, s - pad, s - pad],
        radius=round(s * 0.22), fill=BG + (255,),
        outline=EDGE + (255,), width=max(1, round(s * 0.012)),
    )
    return img.resize((S, S), Image.LANCZOS)


def build_sources() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    green = _r_glyph(GREEN)

    # 1) adaptive foreground — green R only, transparent, masking-safe.
    fg = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    _paste_r(fg, green, diam_frac=FG_SAFE_DIAM)
    fg.save(ASSETS / "icon-foreground.png")

    # 2) adaptive background — near-black, subtle radial.
    _radial_bg(1024).save(ASSETS / "icon-background.png")

    # 3) legacy / store icon — full tile + rim + R (slight optical nudge up).
    #    NOTE: written only as `icon-only.png` (the name @capacitor/assets reads
    #    for the legacy icon). The deliverable alias `icon.png` is written in the
    #    --monochrome/finalize step *after* generation, because the tool treats a
    #    stray `icon.png` as a `logo` source and would run a conflicting pipeline.
    legacy = _tile(1024)
    _paste_r(legacy, green, height_frac=TILE_R_HEIGHT, dy_frac=-0.015)
    legacy.save(ASSETS / "icon-only.png")

    # 4) splash (light + dark are identical — the brand is already dark).
    for name in ("splash.png", "splash-dark.png"):
        sp = Image.new("RGBA", (2732, 2732), BG + (255,))
        _paste_r(sp, green, height_frac=SPLASH_R_HEIGHT)
        sp.convert("RGB").save(ASSETS / name)

    # 5) monochrome source (white R, transparent) for reference / regen.
    mono = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    _paste_r(mono, _r_glyph(WHITE), diam_frac=FG_SAFE_DIAM)
    mono.save(ASSETS / "icon-monochrome.png")

    print("wrote source assets ->", ASSETS)
    for p in sorted(ASSETS.glob("*.png")):
        print(f"  {p.name:22} {Image.open(p).size}")


ADAPTIVE_XML = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <monochrome android:drawable="@mipmap/ic_launcher_foreground_mono"/>
</adaptive-icon>
"""

# Adaptive-icon layers are 108 dp. @capacitor/assets 3.0.5 emits the
# foreground/background at LEGACY (48 dp) pixel sizes, which the launcher then
# upscales ~2.25x when it draws the 108 dp layer -> a soft R. Re-render the
# three adaptive layers at true 108 dp densities so the home-screen icon is
# crisp. (The legacy ic_launcher*.png at 48 dp sizes are left as the tool made
# them — correct for pre-adaptive launchers.)
ADAPTIVE_PX = {"ldpi": 81, "mdpi": 108, "hdpi": 162,
               "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}


def add_monochrome() -> None:
    """Post-generation finalize step:
      * write the deliverable alias `icon.png` (copy of `icon-only.png`);
      * re-render the adaptive foreground/background at true 108 dp densities
        and emit a themed (monochrome) layer alongside them; and
      * rewrite the adaptive-icon XMLs so the mipmaps are referenced DIRECTLY
        (no 16.7% `<inset>` wrapper).

    Why drop the inset: @capacitor/assets wraps the foreground/background in a
    16.7% inset (it assumes an edge-to-edge logo and lets the XML push it into
    the safe zone). Our source PNGs already bake the safe zone in (the R is
    fitted to a 0.60 circumscribed-circle diameter), so a second inset would
    shrink the R to ~40% of the tile AND inset the background, leaving
    transparent margins. Direct references make the rendered icon match the
    mask-simulation montage we verified. The <monochrome> layer lights up
    Android 13+ themed icons with a tinted R instead of a system fallback.
    """
    (ASSETS / "icon.png").write_bytes((ASSETS / "icon-only.png").read_bytes())
    print("  alias ->", (ASSETS / "icon.png").name)

    green = _r_glyph(GREEN)
    white = _r_glyph(WHITE)
    for fg in sorted(RES.glob("mipmap-*/ic_launcher_foreground.png")):
        density = fg.parent.name.split("mipmap-")[1]
        S = ADAPTIVE_PX.get(density, Image.open(fg).size[0])

        f = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        _paste_r(f, green, diam_frac=FG_SAFE_DIAM)
        f.save(fg)

        b = _radial_bg(S)
        b.save(fg.with_name("ic_launcher_background.png"))

        m = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        _paste_r(m, white, diam_frac=FG_SAFE_DIAM)
        m.save(fg.with_name("ic_launcher_foreground_mono.png"))
        print(f"  adaptive {density:8} -> {S}px (fg/bg/mono)")

    for name in ("ic_launcher.xml", "ic_launcher_round.xml"):
        xml = RES / "mipmap-anydpi-v26" / name
        xml.write_text(ADAPTIVE_XML, encoding="utf-8")
        print("  wrote ->", xml.relative_to(RES).as_posix())


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--monochrome", action="store_true",
                    help="post step: emit themed layer + patch adaptive XML")
    args = ap.parse_args()
    if args.monochrome:
        add_monochrome()
    else:
        build_sources()
