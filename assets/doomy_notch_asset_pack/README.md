# Doomy notch-island asset pack

Canvas: 512×512 RGBA PNG
Baseline: y=444 for every frame
Facing: front-on
Background: true transparency
Accent / rim light: #b06cf5
Full style: glossy near-black slime, amber eyes, purple rim light
Mini style: simplified silhouette, eyes and accent only

## State timing

- full/01_idle_base: loop, 12 frames @ 11 fps
- full/02_small_celebration: one-shot, 18 frames @ 11 fps
- full/03_big_celebration: one-shot, 32 frames @ 10 fps
- full/04_needs_you: loop, 14 frames @ 11 fps
- full/05_worried_impatient: loop, 14 frames @ 10 fps
- full/06_working_watching: loop, 12 frames @ 10 fps
- full/07_thinking: loop, 10 frames @ 10 fps
- full/08_talking: loop, 10 frames @ 10 fps
- full/09_sleepy_asleep: loop, 26 frames @ 10 fps
- full/10_waking_up: one-shot, 10 frames @ 10 fps
- full/11_alert_heads_up: one-shot, 15 frames @ 10 fps
- full/12_go_home: loop, 16 frames @ 10 fps

## Mini state timing

- mini/01_idle_base: loop, 12 frames @ 11 fps
- mini/02_small_celebration: one-shot, 18 frames @ 11 fps
- mini/04_needs_you: loop, 14 frames @ 11 fps
- mini/05_worried_impatient: loop, 14 frames @ 10 fps
- mini/06_working_watching: loop, 12 frames @ 10 fps
- mini/09_sleepy_asleep: loop, 26 frames @ 10 fps

## Notes
- PNG frame sequences are the canonical runtime assets.
- preview_gifs/ is included only for quick review.
- Loop states are designed to return visually to frame 0.
- One-shot states return close to the neutral idle pose.
- No floor shadows or backdrop are baked into any frame.
- All outer silhouettes carry a visible purple rim so they remain legible on #000000.