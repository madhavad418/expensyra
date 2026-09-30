# JSAN Expensyra — Brand System

Version 1.3 aligns Expensyra with the actual design language of `jsanconsulting.com`, extracted directly from the live site's compiled CSS (navy/cyan palette, Open Sans, fluid type scale, rounded cards with soft shadows) rather than approximated from memory. The previous version of this document (dark ink/mint-teal, sharp corners) did not match the real site and has been superseded.

## Brand principles

1. **Navy + cyan operating palette** — JSAN navy (`#0050a9`) as the primary brand color, cyan (`#00d4ff`) as the operational-signal accent, applied on light surfaces with dark-navy gradient hero/feature moments — matching the real site's alternating light/dark section rhythm rather than one dark canvas throughout.
2. **Rounded, elevated surfaces** — cards, panels, buttons and chips use JSAN's real radius scale (4/8/16/24px, full pill for buttons/status chips) and soft diffuse shadows, not flat hairline-bordered blocks.
3. **Editorial scale, fluid type** — page titles and hero messages use JSAN's `clamp()`-based fluid heading scale in Open Sans.
4. **Numbered operating model** — Expensyra expresses its own workflow as explicit numbered stages (sidebar nav, process rail). This is a Expensyra-specific device for an internal ops tool, not a verified JSAN website convention — kept because it reads well for an operations product, not claimed as a literal brand pattern.
5. **Evidence over decoration** — cards, tables and status treatments stay restrained and operational; visual hierarchy carries the brand rather than ornamental graphics.

## Expensyra operating sequence

- 01 Sync
- 02 Allocate
- 03 Review
- 04 Classify
- 05 Validate
- 06 Report

## Design tokens

Defined as CSS custom properties in `public/app.css` (`:root`), derived from the real `--jsan-*` tokens found in JSAN's own compiled stylesheet:

```text
Primary (navy)   #0050a9
Accent (cyan)    #00d4ff
Bg dark          #0a1a3a
Bg dark 2        #05132b
Bg primary       #ffffff
Bg secondary     #f8fafc
Text primary     #0a1a3a
Text muted       #5b6b82
Radius sm/md/lg/xl/full   4px / 8px / 16px / 24px / 9999px
Shadow (card)    0 4px 20px rgba(10,26,58,.08)
Font             "Open Sans" (self-hosted variable woff2, public/assets/fonts/open-sans-var.woff2)
```

Do not hard-code colors, spacing or radii outside these tokens — extend the token set in `:root` instead.

## Component mapping

| JSAN website cue (verified from live CSS) | Expensyra implementation |
|---|---|
| Navy/cyan palette | All brand, accent, focus and status-positive colors |
| Rounded cards with soft shadow | `.panel`, `.metric`, `.process-item`, `.receipt-btn`, `.meta`, `.audit-entry` |
| Dark-navy gradient hero sections | Auth hero, dashboard `.ops-hero`, sidebar background, modal header, timer card |
| Pill-shaped buttons/chips | `.btn`, `.status`, `.hero-step` |
| Fluid `clamp()` heading scale | `.hero-copy h1`, `.page-head h2`, `.ops-hero-title`, `.auth-panel h2` |
| Open Sans typography | Global `--jsan-font` |
| Alternating light/dark section rhythm | Light `.content`/`.panel` surfaces vs. dark hero/sidebar/timer/modal-header moments |

## Runtime independence

The build does not download fonts or styling from `jsanconsulting.com` at runtime. Open Sans is self-hosted as a local variable woff2 file, and all CSS/SVG/PNG assets are local, so the production application remains stable even if the public website changes or is unavailable.

## Logo / trademark note

`public/assets/jsan-logo.png` is the approved JSAN corporate logo, supplied directly by JSAN and used as-is (not redrawn). It is a black-wordmark-on-transparent asset, so anywhere it sits on a dark surface (sidebar, auth hero) it is rendered on a small white `.brand-plate` card for contrast rather than placed directly on the dark background.
