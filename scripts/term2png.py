"""Replay a PI_TUI_WRITE_LOG into a terminal grid (pyte) and draw it as a PNG."""
import sys, pyte
from PIL import Image, ImageDraw, ImageFont
log, out, cols, rows = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
regular = ImageFont.truetype(sys.argv[5], 16)
bold = ImageFont.truetype(sys.argv[6], 16) if len(sys.argv) > 6 else regular
screen = pyte.Screen(cols, rows)
stream = pyte.Stream(screen)
stream.feed(open(log, encoding="utf-8", errors="replace").read())
cw, ch = 10, 20
BG, FG = (5, 5, 5), (241, 245, 241)
ANSI = {"black": (0, 0, 0), "red": (205, 49, 49), "green": (13, 188, 121), "yellow": (229, 229, 16), "blue": (36, 114, 200),
        "magenta": (188, 63, 188), "cyan": (17, 168, 205), "white": (229, 229, 229), "brown": (229, 229, 16)}
def color(c, default):
    if c == "default": return default
    if len(c) == 6:
        try: return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))
        except ValueError: pass
    return ANSI.get(c, default)
img = Image.new("RGB", (cols * cw, rows * ch), BG)
d = ImageDraw.Draw(img)
for y in range(rows):
    line = screen.buffer[y]
    for x in range(cols):
        c = line[x]
        fg, bg = color(c.fg, FG), color(c.bg, BG)
        if c.reverse: fg, bg = bg, fg
        d.rectangle([x * cw, y * ch, (x + 1) * cw - 1, (y + 1) * ch - 1], fill=bg)
        if c.data and c.data.strip():
            d.text((x * cw, y * ch + 1), c.data, font=bold if c.bold else regular, fill=fg)
img.save(out)
print(out)
