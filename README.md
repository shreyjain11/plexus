# Plexus

**Live:** [plexus-olive.vercel.app](https://plexus-olive.vercel.app)

**Draw diagrams in the air.** Plexus turns rough, hand-drawn sketches into clean, editable vector figures — flowcharts, pathways, node/arrow diagrams. The primary input is *air-drawing*: track your hand with a webcam, pinch to draw. Mouse and touch work identically as a fallback.

The signature moment is the **snap** — your rough ink resolves into a crisp rectangle, ellipse, or arrow, with a brief `recognized · …` readout. The document stays vector the whole way through, so what you export is editable, not a screenshot.

![Plexus is a sketch-to-clean-diagram tool with webcam hand tracking.](public/favicon.svg)

---

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
```

Then either:

- **Mouse / touch** — start drawing immediately (Draw mode is the default).
- **Hand tracking** — click **Enable hand tracking** in the left rail, allow the camera, and pinch your thumb and index finger together to draw.

Don't want to start from a blank page? Hit **Sample** to load a labeled 4-node pathway.

```bash
npm run build      # type-check + static bundle in dist/
npm run preview    # serve the built bundle locally
npm test           # recognition unit tests (Vitest)
npm run test:e2e   # end-to-end smoke tests (Playwright)
```

---

## How it works

### Recognition engine

Every stroke — from mouse, touch, or a pinch — is an array of `{x, y}` points fed through **one** classifier (`src/recognition/classify.ts`):

1. **Closedness** — a stroke is *closed* when the gap between its first and last point is under `0.28 ×` the bounding-box diagonal **and** its path length comfortably exceeds that diagonal.
2. **Closed → node.** The stroke is resampled to a uniform ring, then:
   - **Corners** are counted from a Ramer–Douglas–Peucker simplification (ε = 4.5% of the diagonal), keeping only vertices whose turning angle is 40°–145° *and* whose local "straw" (ShortStraw, Wolin et al. 2008) dips below the median. The straw test is what separates a drawn square from a circle — a circle's RDP vertices fall inside the angle window too, but their straws never dip.
   - **Radius CV** (std ÷ mean of centroid distances) measures roundness.
   - It's an **ellipse** if CV < 0.19, or (≤ 2 corners and CV < 0.30); otherwise a **rectangle**. A minimum size keeps tiny sketches usable.
3. **Open → connector.** Straightness = `distance(first, last) / pathLength`. Above 0.62 it's a connector (an **arrow** by default, toggle for a plain line); too curly, and the stroke is rejected with a subtle hint.
4. **Snapping** (`src/recognition/snap.ts`) — if a connector endpoint lands within a pad of a node, it attaches to that node. Attached connectors route center-to-center and clip to the node's border (AABB for rectangles, parametric for ellipses), re-routing live as you drag either node.

The engine has a focused unit-test suite (`tests/recognition.test.ts`) covering jittered rectangles, circles, elongated ellipses, straight/bowed lines, scribble rejection, size clamping, snapping, and border clipping.

### Hand-tracking input

- Runs Google's **MediaPipe Hand Landmarker** in-browser (WASM). The index fingertip is the cursor; a thumb↔index **pinch** is pen-down, released is pen-up; an open hand just moves the cursor.
- Raw landmarks are far too noisy to draw with, so they pass through a **One-Euro filter** (`src/input/oneEuro.ts`) — precise when still, low-lag when moving fast.
- The pinch detector uses **hysteresis** (engage tight, release loose) so a held pinch never flickers between states.
- A small mirrored webcam preview shows the detected hand skeleton and a pen up/down indicator.
- If the camera is denied, missing, or the model can't load, the hand UI collapses to a quiet note and mouse + touch stay fully in control.

### Editing

- Click/tap to select, drag to move (attached edges follow), double-click to rename inline.
- **Delete/Backspace** removes the selection and its edges. Multi-level **Undo** (⌘/Ctrl-Z).

### Export

- **SVG** — a standalone, self-contained file with arrowhead marker defs and a padded viewBox. Opens as a clean, editable vector figure anywhere.
- **PNG** — a 2× raster snapshot. The working document itself never rasterizes.

---

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `D` | Draw mode |
| `V` / `S` | Select mode |
| `A` | Toggle arrowheads on new connectors |
| `⌘/Ctrl` + `Z` | Undo |
| `⌘/Ctrl` + `E` | Export SVG |
| `Delete` / `Backspace` | Delete selection |
| `Esc` | Deselect / cancel label edit |

---

## Deploy (Vercel)

Plexus is a static single-page app — no server, no keys.

```bash
npm i -g vercel
vercel            # preview deploy
vercel --prod     # production
```

`vercel.json` sets the Vite framework preset and an SPA fallback rewrite (asset requests are excluded so hashed bundles are served directly). Any static host works too — deploy the contents of `dist/`.

---

## Design decisions & defaults

Picked deliberately so the tool never blocks on a prompt:

- **Model + WASM are fetched from jsDelivr / Google's model host at runtime.** Keeps the repo slim and involves no keys. Hand tracking therefore needs a network connection the first time; drawing with mouse/touch is fully offline.
- **GPU delegate with automatic CPU fallback** for the landmarker.
- **One-Euro** (not a plain EMA) for smoothing — it's the difference between precise and laggy.
- **No browser storage.** Plexus never uses `localStorage` or `sessionStorage`; the document lives in memory for the session.
- **Undo is a snapshot stack** (structural sharing keeps it cheap). No redo in v1.
- A **disabled, unwired serverless stub** lives at `api-stub/cleanup.ts.disabled`, showing where a future server-side "cleanup" key *would* live — never in the client bundle.

---

## Attribution & license

Hand tracking is powered by **Google's [MediaPipe Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker)**. MediaPipe and its models are distributed by Google under the **Apache License 2.0**; the WASM runtime (`@mediapipe/tasks-vision`) and the `hand_landmarker.task` model asset are loaded at runtime and remain the property of their authors. See the [MediaPipe repository](https://github.com/google-ai-edge/mediapipe) for full license terms.

Fonts: IBM Plex Mono and Space Grotesk, both under the SIL Open Font License, self-hosted via Fontsource.

Application code © the Plexus authors, released under the MIT License.
