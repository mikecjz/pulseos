# PulseOS brand assets

The mark is a truncated **sinc RF excitation pulse** on the sequence timeline. Its main lobe is in the accent colour, the way an element you select in the PulseOS viewer is highlighted. The wordmark is **Pulse** in Inter Display SemiBold and **OS** in Inter Display Light. All text is converted to outlines, so the files need no fonts.

`light` = artwork for light backgrounds, `dark` = artwork for dark backgrounds.

| File | Use |
|---|---|
| `logo/pulseos-logo-{light,dark}.svg/.png` | Horizontal lockup (README header, docs, slides). PNG is 1200 px wide, transparent |
| `logo/pulseos-mark-{light,dark}.svg/.png` | Symbol only, transparent, 1024 px PNG |
| `logo/pulseos-icon-{light,dark}.svg/.png` | Rounded tile for app icons and avatars (light tile / dark tile), 1024 px PNG |
| `banner/pulseos-banner-{light,dark}.svg/.png` | 1280×640 banner (GitHub social preview size). PNG is rendered at 2× |
| `logo/pulseos-logo-saira-{light,dark}.svg/.png` | **Alternate** lockup: lowercase `pulseos` in wide Saira Medium (DeepSeek-style type) |
| `banner/pulseos-banner-saira-{light,dark}.svg/.png` | **Alternate** banner, set in Saira |
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

Needs Python 3 with `fontTools`, and Inter installed under `/usr/share/fonts/opentype/inter` (edit `FONT_DIR` otherwise). Inter is under the SIL Open Font License 1.1, which allows use in logos.

The alternate set uses [Saira](https://github.com/Omnibus-Type/Saira) (SIL OFL 1.1, no reserved font name). On first run the script downloads the variable font from the Google Fonts repository into `~/.cache/pulseos-brand/`, then instances it (wordmark: weight 520, width 118). The `p` is redrawn by hand in the script (`_draw_open_p`), so its bowl opens at the bottom-left. The break in the `e` is cut with [skia-pathops](https://pypi.org/project/skia-pathops/) (`pip install skia-pathops`); edit `SAIRA_CUTS` / `SAIRA_DEFAULT_CUTS` in the script to change it.
