# 3DmetaFix

**Check and fix VR180, 360° and stereoscopic 3D metadata in MP4 / MOV videos — losslessly, instantly, and entirely in your browser.**

Drop a video and 3DmetaFix tells you how players will treat it, works out what it *should* be from the picture itself, and writes a corrected copy without re-encoding a single frame.

## Features

- **Instant diagnosis.** Reads Google Spherical Video **V1** (GSpherical XML) and **V2** (`st3d` / `sv3d`), Apple Projected Media / spatial video (`vexu`) and ambisonic audio (`SA3D`). It flags conflicts, malformed XML and misplaced tags.
- **Smart detect.** Samples frames and works out the layout (360° / 180° / flat × 2D / side-by-side / top-bottom), with a confidence level and plain-English reasons. It also warns about unconverted fisheye footage.
- **Live headset preview.** A WebGL viewer shows the video the way a headset will, with the settings you've chosen. You can drag to look around, switch eyes, or check depth in red/cyan anaglyph.
- **Lossless fix.** Writes V1 + V2 by default (or either alone), copies settings from a reference video, or removes VR metadata completely.
- **Proves its work.** After saving, the new file is re-read from disk. Its structure, metadata and media bytes are checked against the original.
- **Private.** No uploads, no server, no install. It works offline once the page has loaded.

## How it works

| Step | What happens |
| --- | --- |
| Inspect | Walks the ISO-BMFF box tree and loads only the `moov` header. Even a 100 GB file opens in milliseconds. |
| Detect | Scores every layout from four cues: a stereo correlation of the halves (on horizontal gradients, across a disparity search), eye aspect ratio, 360° seam wrap-around, and pole stretching. A softmax over those scores gives the confidence. |
| Write | Rebuilds only the header. If the size changes, existing `free` padding absorbs the difference so no media byte moves. Otherwise every absolute offset (`stco`, `co64`, `saio`, fragment `tfhd` / `tfra`) is remapped. 32-bit tables are promoted to 64-bit when needed. |
| Verify | Re-parses the output, confirms the metadata reads back exactly, and compares media bytes at sampled chunk and fragment offsets. |

Saving uses the File System Access API (Chrome, Edge) for direct-to-disk writes with progress and on-disk verification. Other browsers fall back to a normal download.

## Project layout

```
index.html      page markup
css/app.css     design system (dark + light)
js/mp4.js       metadata engine: parse, plan, write, verify (no dependencies; browser + Node)
js/detect.js    smart layout detection (pure functions on pixels)
js/viewer.js    WebGL VR preview
js/app.js       UI controller
tests/          Node tests (engine checked against FFmpeg; detection against rendered scenes)
```

It's a static site with no build step. Open `index.html` locally or host it anywhere, e.g. GitHub Pages.

## Tests

Requires Node 20+ and `ffmpeg` / `ffprobe` on your `PATH`:

```sh
node --test tests/*.test.mjs
```

The engine tests generate real files with FFmpeg: faststart, moov-at-end, QuickTime, fragmented (both offset modes), pre-padded, HEVC and multi-track. After each write they check that FFmpeg reads back the injected metadata and that every audio and video packet is bit-identical. The detection tests render ground-truth scenes with real stereo parallax in every supported projection.
