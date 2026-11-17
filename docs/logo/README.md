# Unramble logo

**Concept A, "loop → tick":** one continuous pen stroke starts as a rambling loop and straightens into a checkmark, i.e. messy speech becoming a tidy task. It beat B (speech-bubble checklist, generic) and C (sound wave → tick, busier at 48 px); see `concepts.png`.

Palette: background `#E8DEF8` (Material3 lavender, matches the app's buttons), mark `#21005D` (dark purple, matches the button icons). The light disc stands out on a black watch face.

Geometry: 1024×1024 viewBox, full-bleed background, one 80-unit round-capped stroke that stays inside the central 66% circle, so a circular launcher mask never clips it.

`app/src/main/res/drawable/ic_launcher.xml` is a hand-copied VectorDrawable of `unramble.svg` (same viewport and pathData). If you change one, change the other.

Re-render: `rsvg-convert -w 512 -h 512 unramble.svg -o unramble-512.png && rsvg-convert -w 48 -h 48 unramble.svg -o unramble-48.png`
