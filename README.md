# Motions-Studios-2
My amazing motion video in Claude

## Motion studio

Each video is one HTML file in `videos/`. It sets:

- `window.DURATION` — length in seconds
- `window.SIZE` — `[width, height]` in pixels (even numbers)
- `window.render(t)` — draws the exact frame at time `t` (seconds)

No CSS animations or timers: everything that moves is driven by `t`, so every render is identical.
Colors and fonts live in `brand.css` (fonts in `fonts/`).

```bash
npm install
node render.mjs hello              # -> out/hello.mp4 (30 fps)
node render.mjs hello --stills 3   # -> out/stills/hello-1.png ... for a quick check
```

Needs Node.js and ffmpeg.
