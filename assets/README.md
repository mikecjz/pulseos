# PulseOS brand assets

The mark is a truncated **sinc RF excitation pulse** on the sequence timeline. Its main lobe is in the accent colour, the way an element you select in the PulseOS viewer is highlighted. The wordmark is lowercase **pulseos** in wide [Saira](https://github.com/Omnibus-Type/Saira) Medium, in the style of the DeepSeek wordmark: the crossbar of the `e` stops short of the bowl, and the `p` is redrawn by hand so its bowl opens at the bottom-left. All text is converted to outlines, so the files need no fonts.

`light` = artwork for light backgrounds, `dark` = artwork for dark backgrounds.

| File | Use |
|---|---|
| `logo/pulseos-logo-{light,dark}.svg/.png` | Horizontal lockup (README header, docs, slides). PNG is 1200 px wide, transparent |
| `logo/pulseos-mark-{light,dark}.svg/.png` | Symbol only, transparent, 1024 px PNG |
| `logo/pulseos-icon-{light,dark}.svg/.png` | Rounded tile for app icons and avatars (light tile / dark tile), 1024 px PNG |
| `banner/pulseos-banner-{light,dark}.svg/.png` | 1280×640 banner (GitHub social preview size). PNG is rendered at 2× |
| `src/generate.py` | Generates all of the above |

## Colours

| Role | Light | Dark |
|---|---|---|
| Ink | `#141829` | `#F1F2F7` |
| Accent (main lobe) | `#F2542D` | `#FF7A50` |
| Muted text | `#5B6178` | `#A3A8BD` |
| Background | `#FFFFFF` / `#F4F5F9` | `#0E1120` / `#161A2E` |

## Usage

- Clear space around the logo: at least the height of the main lobe's stroke × 2 on every side.
- Minimum size: lockup 120 px wide; symbol 24 px. Below 24 px the side lobes merge, so prefer the icon tile.
- Don't recolour the main lobe or the ink separately, stretch the pulse, or put the light artwork on dark backgrounds.

## Regenerating

```sh
python3 assets/src/generate.py         # SVGs
python3 assets/src/generate.py --png   # SVGs + PNGs (needs Chrome/Chromium on PATH)
```

Needs Python 3 with `fontTools` and [skia-pathops](https://pypi.org/project/skia-pathops/) (`pip install fonttools skia-pathops`).

Type is [Saira](https://github.com/Omnibus-Type/Saira) (SIL OFL 1.1, no reserved font name, so logo use and modification are allowed). On first run the script downloads the variable font from the Google Fonts repository into `~/.cache/pulseos-brand/`, then instances it: weight 520 and width 118 for the wordmark, width 104 for the banner text.

The letter changes are in the script. The `e` is cut with skia-pathops (`SAIRA_CUTS`). The `p` is a hand-drawn outline (`_draw_open_p`), tied to the 520/118 instance, and the script stops if that instance changes. `SAIRA_DEFAULT_CUTS` chooses which letters are changed; an optional cut through the `s` is defined but off.
