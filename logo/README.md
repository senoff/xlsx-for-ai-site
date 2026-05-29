# xlsx-for-ai logo assets

Canonical SVG sources for the xlsx-for-ai brand mark. Used for the marketing
site favicon and for connector-directory submissions.

## Files

| File | Purpose |
|---|---|
| `xlsx-for-ai-square.svg` | Square mark — green rounded square with white `x` glyph. Color: brand green `#107c41`. Primary brand asset. |
| `xlsx-for-ai-outline.svg` | Outline variant — white stroke + white `x` on transparent background. For dark surfaces and the MSFT M365 store outline-icon requirement. |

## Specs

- Canvas: 512 × 512 px (`viewBox="0 0 512 512"`)
- Corner radius: 80 px (~15% — modern app-icon convention)
- Brand color: `#107c41` (Excel-green; matches the favicon used since 2026-04)
- Glyph: lowercase `x`, weight 700, size 240, vertically optical-centered at y=340

## PNG rasterization (TODO for connector submissions)

The Microsoft Partner Center submission (M13) requires PNG icons at multiple
sizes (16, 32, 48, 96, 128, 192). These are not yet generated — produce
them when the MSFT submission package is assembled.

Recommended rasterization commands (any one):

```sh
# rsvg-convert (brew install librsvg)
for size in 16 32 48 96 128 192; do
  rsvg-convert -w $size -h $size xlsx-for-ai-square.svg -o xlsx-for-ai-${size}.png
done

# ImageMagick
for size in 16 32 48 96 128 192; do
  magick xlsx-for-ai-square.svg -resize ${size}x${size} xlsx-for-ai-${size}.png
done

# Inkscape (cleanest hinting for small sizes)
for size in 16 32 48 96 128 192; do
  inkscape -w $size -h $size xlsx-for-ai-square.svg -o xlsx-for-ai-${size}.png
done
```

Output PNGs do NOT belong in this repo — they're generated assets for a
specific submission. Treat them as build artifacts.

## Anthropic Connectors Directory

Per Anthropic's submission requirements (A9), the directory accepts a
square logo URL or SVG upload. Use `xlsx-for-ai-square.svg` directly —
no PNG conversion needed for that submission.
