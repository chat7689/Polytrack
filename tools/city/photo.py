# Cuts the aerial photo of the map's box into the textures the game drapes
# over the ground, and a small copy for osm2city.js to read colours from.
#
#   python tools/city/photo.py <north.jpg> <south.jpg> <out-dir> <work-dir>
#
# north.jpg / south.jpg: the box's two halves from Oregon's 2022 statewide
# imagery (tools/city/README.md has the requests). Written:
#   <out-dir>/q00.jpg q10.jpg q01.jpg q11.jpg   four 2048 x 2048 quarters of the
#       1536 m square round the origin (q<i><j>: i 0 = the WEST half, j 0 = the
#       SOUTH half), about 0.375 m a pixel; north up, west on the left
#   <out-dir>/all.jpg    the whole square at 2048 x 2048, for slow computers
#   <work-dir>/photo_1m.rgb   the box at 1 m a pixel, raw RGB, for osm2city.js
# The textures are stored as PAINT, not as the photo looks: the game lights
# them and tone-maps the result (ACES), which would turn a photo nearly white;
# the curve below is that undone, the same one maps/city.js uses for colours.
import sys, os, math
from PIL import Image, ImageFilter

BOX = dict(s=44.02893, n=44.04095, w=-123.0979, e=-123.0806)
ORIGIN = dict(lat=44.0347, lon=-123.0890)
M_LAT = 111132.0
M_LON = 111320.0 * math.cos(math.radians(ORIGIN['lat']))
SQ = 768.0            # half the square the textures cover, metres
LREF = 2.05
GREEN = (88, 140, 68)  # beyond the photo (the same green the far ground has)

def aces(v):
    return max(0.0, min(1.0, (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081)))

def tone_lut():
    lut = []
    for v8 in range(256):
        s = v8 / 255.0
        target = s / 12.92 if s <= 0.04045 else ((s + 0.055) / 1.055) ** 2.4
        lo, hi = 0.0, 8.0
        for _ in range(26):
            m = (lo + hi) / 2
            if aces(m) < target: lo = m
            else: hi = m
        a = lo * 0.6 / LREF
        e = a * 12.92 if a <= 0.0031308 else 1.055 * a ** (1 / 2.4) - 0.055
        lut.append(max(0, min(255, round(e * 255))))
    return lut * 3

def main():
    north, south, out_dir, work_dir = sys.argv[1:5]
    a, b = Image.open(north).convert('RGB'), Image.open(south).convert('RGB')
    # Where each half really lies. The server keeps a pixel square in DEGREES:
    # asked for a size that is not the box's shape, it widens the box north and
    # south about its middle. So each half covers more latitude than was asked
    # (they overlap), at a pixel of (east - west) / width degrees both ways.
    px = (BOX['e'] - BOX['w']) / a.width
    mid = (BOX['s'] + BOX['n']) / 2
    n_top = (mid + BOX['n']) / 2 + a.height * px / 2          # the north half's top
    s_top = (BOX['s'] + mid) / 2 + b.height * px / 2          # the south half's top
    off = round((n_top - s_top) / px)
    full = Image.new('RGB', (a.width, off + b.height))
    full.paste(b, (0, off)); full.paste(a, (0, 0))
    W, H = full.size
    # game (x west-positive, z north-positive) -> photo pixel
    def col(x): return ((ORIGIN['lon'] - x / M_LON) - BOX['w']) / px
    def row(z): return (n_top - (ORIGIN['lat'] + z / M_LAT)) / px
    # only the map's own box is kept (the downloads reach a little past it, and
    # the ground beyond the box takes the picture's edge: that must be plain green)
    from PIL import ImageDraw
    x0b, x1b = (ORIGIN['lon'] - BOX['e']) * M_LON, (ORIGIN['lon'] - BOX['w']) * M_LON
    z0b, z1b = (BOX['s'] - ORIGIN['lat']) * M_LAT, (BOX['n'] - ORIGIN['lat']) * M_LAT
    white = Image.new('L', full.size, 0)
    ImageDraw.Draw(white).rectangle([col(x1b + 8), row(z1b + 8), col(x0b - 8), row(z0b - 8)], fill=255)
    lut = tone_lut()
    os.makedirs(out_dir, exist_ok=True)

    def cut(x_west, z_north, span, size, name):
        # output pixel (i, j) -> x = x_west - (i + .5) / size * span, z = z_north - (j + .5) / size * span
        k = span / size
        ax = (col(x_west - k) - col(x_west))          # photo columns per output column
        ey = (row(z_north - k) - row(z_north))
        coef = (ax, 0, col(x_west - 0.5 * k), 0, ey, row(z_north - 0.5 * k))
        img = full.transform((size, size), Image.AFFINE, coef, resample=Image.BICUBIC, fillcolor=GREEN)
        mask = white.transform((size, size), Image.AFFINE, coef, resample=Image.BILINEAR, fillcolor=0)
        mask = mask.filter(ImageFilter.GaussianBlur(12 * (768.0 / span) * (size / 2048.0) + 2))
        # (only fade where the photo ends: inside it the mask is still white after the blur)
        img = Image.composite(img, Image.new('RGB', (size, size), GREEN), mask)
        img.point(lut).save(os.path.join(out_dir, name), quality=84, optimize=True)
        print(name, os.path.getsize(os.path.join(out_dir, name)) // 1024, 'KB')

    for i in (0, 1):
        for j in (0, 1):
            cut(SQ - i * SQ, (j + 1) * SQ - SQ, SQ, 2048, 'q%d%d.jpg' % (i, j))
    cut(SQ, SQ, 2 * SQ, 2048, 'all.jpg')
    # the box at 1 m a pixel, as it is (for roof and tree colours)
    x0, x1 = (ORIGIN['lon'] - BOX['e']) * M_LON, (ORIGIN['lon'] - BOX['w']) * M_LON
    z0, z1 = (BOX['s'] - ORIGIN['lat']) * M_LAT, (BOX['n'] - ORIGIN['lat']) * M_LAT
    w1, h1 = round(x1 - x0), round(z1 - z0)
    small = full.transform((w1, h1), Image.AFFINE, (col(x1 - 1) - col(x1), 0, col(x1 - 0.5), 0, row(z1 - 1) - row(z1), row(z1 - 0.5)), resample=Image.BICUBIC)
    os.makedirs(work_dir, exist_ok=True)
    with open(os.path.join(work_dir, 'photo_1m.rgb'), 'wb') as f:
        f.write(small.tobytes())
    print('photo_1m.rgb', w1, 'x', h1)

main()
