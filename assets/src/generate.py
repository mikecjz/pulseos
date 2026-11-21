#!/usr/bin/env python3
"""Generate the PulseOS logo and banner SVGs.

The mark is a truncated sinc RF excitation pulse sitting on the sequence
timeline. Its main lobe is drawn in the accent colour, the way an element
selected in the PulseOS viewer is highlighted.

Text is converted to outlines (Inter Display, SIL OFL 1.1), so the SVGs have
no font dependency. Re-run after changing anything here:

    python3 assets/src/generate.py            # writes the SVGs
    python3 assets/src/generate.py --png      # also renders PNGs (needs Chrome)
"""
from __future__ import annotations

import argparse
import math
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]  # assets/
FONT_DIR = Path("/usr/share/fonts/opentype/inter")

# Alternate wordmark: Saira (SIL OFL 1.1, https://github.com/Omnibus-Type/Saira),
# a squarish grotesk close in spirit to the DeepSeek wordmark. The variable font
# is downloaded once and instanced locally.
SAIRA_URL = "https://github.com/google/fonts/raw/main/ofl/saira/Saira%5Bwdth,wght%5D.ttf"
CACHE = Path.home() / ".cache" / "pulseos-brand"


def saira(wght: float, wdth: float) -> TTFont:
    from fontTools.varLib import instancer

    vf = CACHE / "Saira-VF.ttf"
    if not vf.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(SAIRA_URL, vf)
    return instancer.instantiateVariableFont(TTFont(vf), {"wght": wght, "wdth": wdth})

# --------------------------------------------------------------------------- palette
PALETTE = {
    "light": {  # artwork for light backgrounds
        "ink": "#141829",
        "accent": "#F2542D",
        "muted": "#5B6178",
        "bg": "#FFFFFF",
        "bg2": "#F4F5F9",
        "rail": "#141829",
    },
    "dark": {  # artwork for dark backgrounds
        "ink": "#F1F2F7",
        "accent": "#FF7A50",
        "muted": "#A3A8BD",
        "bg": "#0E1120",
        "bg2": "#161A2E",
        "rail": "#F1F2F7",
    },
}

# --------------------------------------------------------------------------- the pulse

STROKE = 17.0  # on the 256 symbol grid
X0, X1 = 22.0, 234.0  # baseline extent of the symbol
PX0, PX1 = 42.0, 214.0  # where the sinc lives (x = -3 .. 3)
BASE_Y = 172.0  # timeline
PEAK = 120.0  # main lobe height above the timeline


def _sinc(x: float) -> float:
    return 1.0 if abs(x) < 1e-9 else math.sin(math.pi * x) / (math.pi * x)


def _amp(x: float) -> float:
    """Truncated sinc, side lobes boosted for legibility, tapered to zero slope at +-3."""
    w = 1.0 - (abs(x) / 3.0) ** 6
    boost = 1.0 + 0.65 * min(x * x, 1.0)
    return _sinc(x) * w * boost


def _pt(x: float) -> tuple[float, float]:
    sx = PX0 + (x + 3.0) / 6.0 * (PX1 - PX0)
    return sx, BASE_Y - PEAK * _amp(x)


def _bezier_path(xs: list[float], move: bool = True) -> str:
    """Smooth curve through sampled points (Catmull-Rom -> cubic Bezier)."""
    pts = [_pt(x) for x in xs]
    out = [f"M{pts[0][0]:.2f} {pts[0][1]:.2f}"] if move else []
    for i in range(len(pts) - 1):
        p0 = pts[i - 1] if i > 0 else pts[i]
        p1, p2 = pts[i], pts[i + 1]
        p3 = pts[i + 2] if i + 2 < len(pts) else pts[i + 1]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        out.append(
            f"C{c1[0]:.2f} {c1[1]:.2f} {c2[0]:.2f} {c2[1]:.2f} {p2[0]:.2f} {p2[1]:.2f}"
        )
    return "".join(out)


def _samples(a: float, b: float, n: int) -> list[float]:
    return [a + (b - a) * i / n for i in range(n + 1)]


def pulse_paths() -> tuple[str, str, str]:
    """Return (left side, main lobe, right side) as stroke paths on the 256 grid."""
    left = f"M{X0} {BASE_Y}H{PX0}" + _bezier_path(_samples(-3, -1, 16), move=False)
    main = _bezier_path(_samples(-1, 1, 12))
    right = _bezier_path(_samples(1, 3, 16)) + f"H{X1}"
    return left, main, right


def symbol_group(ink: str, accent: str, stroke: float = STROKE) -> str:
    left, main, right = pulse_paths()
    common = f'fill="none" stroke-width="{stroke}" stroke-linejoin="round"'
    return (
        f'<path d="{left}" stroke="{ink}" {common} stroke-linecap="round"/>'
        f'<path d="{right}" stroke="{ink}" {common} stroke-linecap="round"/>'
        f'<path d="{main}" stroke="{accent}" {common} stroke-linecap="butt"/>'
    )


# --------------------------------------------------------------------------- type


class Type:
    def __init__(self, name: "str | TTFont"):
        self.font = name if isinstance(name, TTFont) else TTFont(FONT_DIR / name)
        self.gs = self.font.getGlyphSet()
        self.cmap = self.font.getBestCmap()
        self.upm = self.font["head"].unitsPerEm
        self.cap = self.font["OS/2"].sCapHeight
        self.xh = self.font["OS/2"].sxHeight
        self.kern = self._pair_kerning()

    def _pair_kerning(self) -> dict[tuple[str, str], int]:
        """Flatten GPOS PairPos (format 1 and 2) for the glyphs we use."""
        table: dict[tuple[str, str], int] = {}
        gpos = self.font["GPOS"].table
        for lookup in gpos.LookupList.Lookup:
            for st in lookup.SubTable:
                if lookup.LookupType == 9:
                    st = st.ExtSubTable
                if getattr(st, "LookupType", lookup.LookupType) != 2:
                    continue
                cov = st.Coverage.glyphs
                if st.Format == 1:
                    for g1, ps in zip(cov, st.PairSet):
                        for rec in ps.PairValueRecord:
                            v = getattr(rec.Value1, "XAdvance", 0) or 0
                            table.setdefault((g1, rec.SecondGlyph), v)
                elif st.Format == 2:
                    c1 = st.ClassDef1.classDefs
                    c2 = st.ClassDef2.classDefs
                    second: dict[int, list[str]] = {}
                    for g, c in c2.items():
                        second.setdefault(c, []).append(g)
                    for g1 in cov:
                        row = st.Class1Record[c1.get(g1, 0)]
                        for ci, rec in enumerate(row.Class2Record):
                            v = getattr(rec.Value1, "XAdvance", 0) or 0
                            if not v:
                                continue
                            for g2 in second.get(ci, []):
                                table.setdefault((g1, g2), v)
        return table

    def path(self, text: str, size: float, x: float, y: float, tracking: float = 0.0,
             extra: dict[int, float] | None = None,
             cuts: dict[str, list[tuple[float, float, float, float]]] | None = None) -> tuple[str, float]:
        """Outline `text` with its baseline at y. Returns (path data, advance width).

        `cuts` maps a character to rectangles (x0, y0, x1, y1, in font units) removed
        from that glyph, e.g. to detach a bar or a bowl.
        """
        s = size / self.upm
        pen = SVGPathPen(self.gs)
        cx = 0.0
        prev = None
        for i, ch in enumerate(text):
            g = self.cmap[ord(ch)]
            if prev is not None:
                cx += self.kern.get((prev, g), 0) + tracking * self.upm
            if extra and i in extra:
                cx += extra[i] * self.upm
            tp = TransformPen(pen, (s, 0, 0, -s, x + cx * s, y))
            if cuts and callable(cuts.get(ch)):
                cuts[ch](self.gs[g], tp)
            elif cuts and ch in cuts:
                _cut_glyph(self.gs[g], cuts[ch]).draw(tp)
            else:
                self.gs[g].draw(tp)
            cx += self.gs[g].width
            prev = g
        return pen.getCommands(), cx * s


# --------------------------------------------------------------------------- artwork

def svg(w: float, h: float, body: str, title: str) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:g} {h:g}" '
        f'width="{w:g}" height="{h:g}" role="img" aria-label="{title}">'
        f"<title>{title}</title>{body}</svg>\n"
    )


class InterWordmark:
    """"Pulse" Inter Display SemiBold + "OS" Inter Display Light."""

    def __init__(self):
        self.bold = Type("InterDisplay-SemiBold.otf")
        self.light = Type("InterDisplay-Light.otf")
        self.text = Type("Inter-Regular.otf")
        self.text_med = Type("Inter-Medium.otf")

    def __call__(self, ink: str, scale: float) -> tuple[str, float]:
        cap = 92.0 * scale
        size = cap / self.bold.cap * self.bold.upm
        d1, w1 = self.bold.path("Pulse", size, 0, 0, tracking=-0.012)
        gap = size * 0.035
        d2, w2 = self.light.path("OS", size, w1 + gap, 0, tracking=-0.006)
        return (f'<path d="{d1}" fill="{ink}"/><path d="{d2}" fill="{ink}"/>', w1 + gap + w2)


def _cut_glyph(glyph, rects):
    """Glyph outline minus rectangles (boolean difference via skia-pathops)."""
    import pathops

    ink = pathops.Path()
    glyph.draw(ink.getPen(glyphSet=None))
    ink.simplify()
    hole = pathops.Path()
    pen = hole.getPen()
    for x0, y0, x1, y1 in rects:
        pen.moveTo((x0, y0)); pen.lineTo((x0, y1)); pen.lineTo((x1, y1)); pen.lineTo((x1, y0))
        pen.closePath()
    return pathops.op(ink, hole, pathops.PathOp.DIFFERENCE)


# Breaks in the Saira wordmark, in font units (Saira wght 520 / wdth 118).
def _draw_open_p(glyph, pen) -> None:
    """Hand-redrawn "p": the bowl's bottom stroke ends in a square terminal
    64 units short of the stem (the same gap as the "e"), and the stem's right
    edge runs straight down. One contour; coordinates are Saira wght 520 /
    wdth 118 font units, taken from the original outline where unchanged."""
    assert glyph.width == 648, "p redraw is tied to the Saira 520/118 instance"
    pen.moveTo((89, -201))
    pen.lineTo((89, 510))
    pen.lineTo((190, 510))
    pen.lineTo((193, 440))
    pen.lineTo((201, 440))
    pen.qCurveTo((218, 473), (274, 506), (344, 518), (379, 518))           # shoulder
    pen.qCurveTo((435, 518), (513, 493), (559, 433), (580, 332), (580, 256))
    pen.qCurveTo((580, 180), (560, 77), (514, 18), (439, -8), (383, -8))
    pen.lineTo((262, -8))                                                  # flat bottom
    pen.lineTo((262, 89))                                                  # square terminal
    pen.lineTo((334, 89))
    pen.qCurveTo((380, 89), (435, 100), (462, 133), (471, 199), (471, 255))  # counter
    pen.qCurveTo((471, 311), (462, 377), (435, 412), (380, 423), (334, 423))
    pen.qCurveTo((286, 423), (229, 400), (216, 376))
    pen.qCurveTo((203, 356), (198, 294), (198, 255))
    pen.lineTo((198, -201))                                                # stem, right edge
    pen.closePath()


# "e": the crossbar stops short of the bowl's left wall, like the DeepSeek "e".
# "p": the bowl opens at the bottom-left, like the DeepSeek "p" (redrawn, not cut).
# "s" is an option (not used by default): a cut through the spine.
SAIRA_CUTS = {
    "e": [(177, 200, 241, 310)],
    "p": _draw_open_p,
    "s": [(246, 170, 300, 330)],
}
SAIRA_DEFAULT_CUTS = ("e", "p")


class SairaWordmark:
    """Lowercase "pulseos" in wide Saira Medium, one weight, one colour."""

    def __init__(self, cut: tuple[str, ...] = SAIRA_DEFAULT_CUTS):
        self.cuts = {c: SAIRA_CUTS[c] for c in cut}
        self.word = Type(saira(520, 118))
        self.text = Type(saira(400, 104))
        self.text_med = Type(saira(500, 104))

    def __call__(self, ink: str, scale: float) -> tuple[str, float]:
        xh = 62.0 * scale  # x-height on the 256 grid
        size = xh / self.word.xh * self.word.upm
        d, w = self.word.path("pulseos", size, 0, 0, tracking=-0.012, cuts=self.cuts)
        return f'<path d="{d}" fill="{ink}"/>', w


def build(png: bool) -> list[Path]:
    # suffix -> wordmark style; "" is the primary (Inter) set
    styles = {"": InterWordmark(), "-saira": SairaWordmark()}
    written: list[Path] = []

    def save(rel: str, content: str) -> None:
        p = ROOT / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
        written.append(p)

    for mode, c in PALETTE.items():
        # symbol, transparent
        save(f"logo/pulseos-mark-{mode}.svg",
             svg(256, 256, symbol_group(c["ink"], c["accent"]), "PulseOS"))

        # app icon / avatar tile: the tile flips with the mode
        # "dark" icon = dark tile, "light" icon = light tile
        tile_bg = PALETTE["light"]["bg2"] if mode == "light" else PALETTE["dark"]["bg"]
        tile_ink = PALETTE[mode]["ink"]
        tile_acc = PALETTE[mode]["accent"]
        icon = (f'<rect width="256" height="256" rx="56" fill="{tile_bg}"/>'
                f'<g transform="translate(128 132) scale(0.78) translate(-128 -128)">'
                f'{symbol_group(tile_ink, tile_acc, STROKE * 1.12)}</g>')
        save(f"logo/pulseos-icon-{mode}.svg", svg(256, 256, icon, "PulseOS"))

        for suffix, wordmark in styles.items():
            # horizontal lockup: wordmark baseline sits on the pulse timeline
            wm, ww = wordmark(c["ink"], 1.0)
            gap = 40.0
            base_shift = BASE_Y + STROKE / 2  # text baseline on the bottom edge of the timeline
            w = X1 + STROKE / 2 + gap + ww + 8
            body = (f'<g transform="translate({-X0 + STROKE / 2 + 4:.2f} 0)">'
                    f'{symbol_group(c["ink"], c["accent"])}'
                    f'<g transform="translate({X1 + STROKE / 2 + gap:.2f} {base_shift:.2f})">{wm}</g></g>')
            save(f"logo/pulseos-logo{suffix}-{mode}.svg",
                 svg(round(w - X0 + STROKE / 2 + 4), 256, body, "PulseOS"))

            # banner 1280x640 (GitHub social preview size)
            save(f"banner/pulseos-banner{suffix}-{mode}.svg", banner(c, mode, wordmark))

    if png:
        render(written)
    return written


def banner(c: dict, mode: str, wordmark) -> str:
    text, text_med = wordmark.text, wordmark.text_med
    W, H = 1280, 640
    parts = [f'<rect width="{W}" height="{H}" fill="{c["bg"]}"/>']

    # background: a faint pulse sequence diagram (RF, Gz, Gy, Gx, ADC rails)
    rails_x0, rails_x1 = 800, 1280
    rail_y = [150, 250, 340, 430, 520]
    op = 0.10 if mode == "light" else 0.12
    g = [f'<g fill="none" stroke="{c["rail"]}" stroke-width="3" stroke-linejoin="round" '
         f'stroke-linecap="round" opacity="{op}">']
    for y in rail_y:
        g.append(f'<path d="M{rails_x0} {y}H{rails_x1}"/>')

    def trap(x, y, w, h, r=14):  # gradient lobe
        return f'<path d="M{x} {y}L{x + r} {y - h}H{x + w - r}L{x + w} {y}"/>'

    g.append(trap(850, 250, 150, 40))            # slice select
    g.append(trap(1004, 250, 64, -30, 10))       # rephaser
    g.append(trap(1010, 340, 70, 30, 10))        # phase encode (table)
    g.append(trap(1010, 340, 70, 18, 10))
    g.append(trap(1010, 340, 70, -18, 10))
    g.append(trap(1010, 340, 70, -30, 10))
    g.append(trap(1010, 430, 70, -28, 10))       # readout prephaser
    g.append(trap(1090, 430, 190, 32, 16))       # readout
    g.append(f'<path d="M1106 520V490H1264V520"/>')  # ADC window
    g.append("</g>")
    parts += g
    # the real pulse on the RF rail, in brand colours, echoing the mark
    parts.append(
        f'<g transform="translate(925 {150 - BASE_Y * 0.62:.2f}) scale(0.62) translate(-128 0)" opacity="{0.9 if mode == "light" else 0.95}">'
        f'<g opacity="0.35">{symbol_group(c["rail"], c["accent"], 6)}</g></g>'
    )

    # lockup
    x, ymid = 96, 262
    k = 0.8
    parts.append(f'<g transform="translate({x - (X0 - STROKE / 2) * k:.2f} {ymid - 128 * k:.2f}) scale({k})">'
                 f'{symbol_group(c["ink"], c["accent"])}</g>')
    base = ymid - 128 * k + (BASE_Y + STROKE / 2) * k
    wm, ww = wordmark(c["ink"], k)
    parts.append(f'<g transform="translate({x + (X1 - X0 + STROKE) * k + 40 * k:.2f} {base:.2f})">{wm}</g>')

    # tagline
    t1, _ = text.path("MR pulse sequence development", 40, x, 402, tracking=-0.01)
    t2, _ = text.path("with an LLM in the loop.", 40, x, 456, tracking=-0.01)
    parts.append(f'<path d="{t1}" fill="{c["muted"]}"/><path d="{t2}" fill="{c["muted"]}"/>')
    # footer
    f1, _ = text_med.path("pypulseq  ·  interactive sequence viewer  ·  chat-referenced elements",
                          22, x, 560, tracking=0.0)
    parts.append(f'<path d="{f1}" fill="{c["muted"]}" opacity="0.8"/>')
    return svg(W, H, "".join(parts), "PulseOS — MR pulse sequence development with an LLM in the loop")


# --------------------------------------------------------------------------- PNG

def _chrome() -> str | None:
    for n in ("google-chrome", "chromium", "chromium-browser", "chrome"):
        p = shutil.which(n)
        if p:
            return p
    return None


def render(files: list[Path]) -> None:
    chrome = _chrome()
    if not chrome:
        sys.exit("PNG export needs Chrome/Chromium on PATH")
    for f in files:
        text = f.read_text()
        vb = text.split('viewBox="')[1].split('"')[0].split()
        w, h = float(vb[2]), float(vb[3])
        scale = 2 if "banner" in f.name else max(1, round(1024 / max(w, h) * 1)) if "logo-" not in f.name else 4
        if "logo-" in f.name:
            scale = 1200 / w  # lockup: 1200 px wide
        elif "banner" not in f.name:
            scale = 1024 / w  # symbol / icon: 1024 px
        pw, ph = round(w * scale), round(h * scale)
        with tempfile.TemporaryDirectory() as td:
            html = Path(td) / "r.html"
            html.write_text(
                "<!doctype html><html><head><style>html,body{margin:0;background:transparent}"
                f"img{{display:block;width:{pw}px;height:{ph}px}}</style></head><body>"
                f'<img src="{f.as_uri()}"></body></html>'
            )
            out = f.with_suffix(".png")
            subprocess.run(
                [chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                 "--default-background-color=00000000", "--allow-file-access-from-files",
                 f"--window-size={pw},{ph}", f"--screenshot={out}", html.as_uri()],
                check=True, capture_output=True,
            )


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--png", action="store_true")
    a = ap.parse_args()
    for p in build(a.png):
        print(p.relative_to(ROOT.parent))
