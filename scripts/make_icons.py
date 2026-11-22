"""Draw the app icon (radar sweep on a coral tile) at every size the PWA needs."""
import sys
from PIL import Image, ImageDraw

OUT = sys.argv[1] if len(sys.argv) > 1 else 'public/icons'
CORAL = (255, 90, 54, 255)
DARK = (15, 15, 18, 255)

def radar(size, bg, fg, pad_ratio=0.0, rounded=True):
    S = 1024
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if bg:
        if rounded:
            d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.225), fill=bg)
        else:
            d.rectangle([0, 0, S, S], fill=bg)
    c = S / 2
    scale = 1 - pad_ratio
    w = int(46 * scale)
    # sweep wedge
    r = 300 * scale
    sweep = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sweep)
    sd.pieslice([c - r, c - r, c + r, c + r], start=-90, end=-20, fill=fg[:3] + (90,))
    img = Image.alpha_composite(img, sweep)
    d = ImageDraw.Draw(img)
    for rr in (300, 190):
        rr *= scale
        d.ellipse([c - rr, c - rr, c + rr, c + rr], outline=fg, width=w)
    dot = 62 * scale
    d.ellipse([c - dot, c - dot, c + dot, c + dot], fill=fg)
    # sweep arm
    d.line([c, c, c + r * 0.94 * 0.342, c - r * 0.94 * 0.94], fill=fg, width=w)
    # blip
    bx, by = c + 200 * scale, c - 142 * scale
    b = 40 * scale
    d.ellipse([bx - b, by - b, bx + b, by + b], fill=fg)
    return img.resize((size, size), Image.LANCZOS)

white = (255, 255, 255, 255)
radar(192, CORAL, white).save(f'{OUT}/icon-192.png')
radar(512, CORAL, white).save(f'{OUT}/icon-512.png')
radar(512, CORAL, white, pad_ratio=0.22, rounded=False).save(f'{OUT}/icon-maskable-512.png')
apple = radar(180, CORAL, white, rounded=False)
apple.save(f'{OUT}/apple-touch-icon.png')
radar(96, None, white, pad_ratio=0.05).save(f'{OUT}/badge-96.png')
print('icons written to', OUT)
