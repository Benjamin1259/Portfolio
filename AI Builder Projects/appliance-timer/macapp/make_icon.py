"""Draw the app icon (the extension's sun-clock) at every size macOS wants, into an .iconset folder.

    python3 make_icon.py build/AppIcon.iconset && iconutil -c icns build/AppIcon.iconset
"""
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

BLUE, BLUE_DOT, SUN = (31, 95, 174), (44, 110, 190), (246, 183, 45)


def draw(size=1024):
    s = size / 1024
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    # macOS icon grid: an 824 px rounded square with a soft shadow
    box = [100 * s, 92 * s, 924 * s, 916 * s]
    shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([box[0], box[1] + 12 * s, box[2], box[3] + 12 * s], 185 * s, fill=(0, 0, 0, 90))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(14 * s)))
    tile = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(tile)
    d.rounded_rectangle(box, 185 * s, fill=BLUE)
    for x in range(int(box[0]) + int(18 * s), int(box[2]), max(1, int(36 * s))):     # the extension icon's dot texture
        for y in range(int(box[1]) + int(18 * s), int(box[3]), max(1, int(36 * s))):
            d.ellipse([x - 4 * s, y - 4 * s, x + 4 * s, y + 4 * s], fill=BLUE_DOT)
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, 185 * s, fill=255)
    img.paste(tile, (0, 0), mask)

    d = ImageDraw.Draw(img)
    cx, cy = 512 * s, 504 * s
    for k in range(8):                                    # rays
        a = k * math.pi / 4
        x0, y0 = cx + math.cos(a) * 290 * s, cy + math.sin(a) * 290 * s
        x1, y1 = cx + math.cos(a) * 360 * s, cy + math.sin(a) * 360 * s
        d.line([x0, y0, x1, y1], fill=SUN, width=int(44 * s))
        for x, y in ((x0, y0), (x1, y1)):
            d.ellipse([x - 22 * s, y - 22 * s, x + 22 * s, y + 22 * s], fill=SUN)
    r = 238 * s
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=SUN)
    w = int(40 * s)                                       # clock hands: 12 and 3 o'clock
    d.line([cx, cy - 150 * s, cx, cy], fill=BLUE, width=w)
    d.line([cx, cy, cx + 110 * s, cy], fill=BLUE, width=w)
    for x, y in ((cx, cy - 150 * s), (cx, cy), (cx + 110 * s, cy)):
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=BLUE)
    return img


if __name__ == "__main__":
    out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
    big = draw(1024)
    for pt in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            px = pt * scale
            im = draw(px) if px >= 128 else big.resize((px, px), Image.LANCZOS)
            im.save(out / f"icon_{pt}x{pt}{'@2x' if scale == 2 else ''}.png")
