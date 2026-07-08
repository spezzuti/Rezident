"""System-tray fallback used when the WebView2 runtime is unavailable.

Keeps Rezident usable as "local server + open in your default browser": a tray
icon with Open and Quit. Imported lazily by app.py; if pystray/Pillow are
missing the caller degrades to a plain keep-alive loop.
"""

import webbrowser
from pathlib import Path

_ICON = Path(__file__).resolve().parent / "assets" / "agentos.ico"


def _icon_image():
    from PIL import Image, ImageDraw

    if _ICON.exists():
        try:
            return Image.open(_ICON)
        except Exception:
            pass
    img = Image.new("RGBA", (64, 64), (5, 6, 12, 255))
    d = ImageDraw.Draw(img)
    d.rectangle([10, 10, 54, 54], outline=(62, 245, 160, 255), width=4)
    d.rectangle([26, 24, 38, 44], fill=(62, 245, 160, 255))
    return img


def run_tray(app_url: str, server) -> None:
    """Blocks on the tray event loop until the user chooses Quit."""
    import pystray

    def on_open(icon, item):
        webbrowser.open(app_url)

    def on_quit(icon, item):
        icon.stop()
        try:
            server.stop()
        except Exception:
            pass

    menu = pystray.Menu(
        pystray.MenuItem("Open Rezident", on_open, default=True),
        pystray.MenuItem("Quit", on_quit),
    )
    pystray.Icon("Rezident", _icon_image(), "Rezident", menu).run()
