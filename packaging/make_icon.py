"""Generate the AgentOS window/taskbar/tray icon (multi-resolution .ico).

Run once (Pillow required):
    backend/.venv/Scripts/python.exe packaging/make_icon.py
-> backend/desktop/assets/agentos.ico
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "backend" / "desktop" / "assets" / "agentos.ico"
OUT.parent.mkdir(parents=True, exist_ok=True)

BG = (8, 10, 18, 255)
EDGE = (62, 245, 160, 255)   # GRID//OS green
DIM = (18, 53, 42, 255)


def render(size: int) -> Image.Image:
    s = 256
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # rounded panel
    d.rounded_rectangle([12, 12, s - 12, s - 12], radius=40, fill=BG, outline=EDGE, width=8)
    # shield (ICE) silhouette
    cx = s // 2
    shield = [(cx, 60), (196, 92), (196, 150), (cx, 210), (60, 150), (60, 92)]
    d.polygon(shield, fill=DIM, outline=EDGE)
    # keyhole / prompt caret
    d.ellipse([cx - 20, 110, cx + 20, 150], fill=EDGE)
    d.rectangle([cx - 9, 132, cx + 9, 182], fill=EDGE)
    return img.resize((size, size), Image.LANCZOS)


sizes = [16, 24, 32, 48, 64, 128, 256]
base = render(256)
base.save(OUT, format="ICO", sizes=[(x, x) for x in sizes])
print(f"wrote {OUT} ({', '.join(str(x) for x in sizes)})")
