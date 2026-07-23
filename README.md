# Plexus

**Live:** [plexus-olive.vercel.app](https://plexus-olive.vercel.app)

**Draw diagrams in the air.** Plexus turns rough, hand-drawn sketches into clean, editable vector figures — flowcharts, pathways, node/arrow diagrams. The primary input is *air-drawing*: track your hand with a webcam, pinch to draw. Mouse and touch work identically as a fallback.

The signature moment is the **snap** — your rough ink resolves into a crisp rectangle, ellipse, diamond, or arrow, with a brief `recognized · …` readout. Or skip the ink entirely: **pinch both hands and frame a shape in the air**, and it exists. The document stays vector the whole way through, so what you export is editable, not a screenshot.

Beyond drawing, Plexus is a real editor: a shape palette, **text boxes**, resize handles, node fills, edge labels, alignment snapping, redo, duplicate, zoom/pan, and autosave — so it's a tool you can actually build a diagram in, not just a demo.

![Plexus is a sketch-to-clean-diagram tool with webcam hand tracking.](public/favicon.svg)

---

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
```

Then any of:

- **Mouse / touch** — start drawing immediately (Draw mode is the default).
- **Shape palette** — click Rectangle / Ellipse / Diamond in the rail to drop a clean shape at the center of the view, no drawing required.
- **Text tool** (`T`) — click anywhere to place a text box and start typing.
- **Hand tracking** — click **Enable hand tracking** in the left rail, allow the camera, and pinch thumb-to-index to draw. Pinch **both** hands at once to frame the armed palette shape between them.

Don't want to start from a blank page? Hit **Sample** to load a labeled 4-node pathway. Your work **autosaves** to the browser, so a reload picks up where you left off.

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
   - **Corners** are located from a Ramer–Douglas–Peucker simplification (ε = 4.5% of the diagonal), keeping only vertices whose turning angle is 40°–145° *and* whose local "straw" (ShortStraw, Wolin et al. 2008) dips below the median. The straw test is what separates a drawn square from a circle — a circle's RDP vertices fall inside the angle window too, but their straws never dip.
   - **Radius CV** (std ÷ mean of centroid distances) measures roundness.
   - It's an **ellipse** if CV < 0.19, or (≤ 2 corners and CV < 0.30); otherwise a **rectangle** — unless the four corners sit near the *edge midpoints* of the bounding box rather than its corners, in which case it's a **diamond** (decision node). A minimum size keeps tiny sketches usable.
3. **Open → connector.** Straightness = `distance(first, last) / pathLength`. Above 0.62 it's a connector (an **arrow** by default, toggle for a plain line); too curly, and the stroke is rejected with a subtle hint.
4. **Snapping** (`src/recognition/snap.ts`) — if a connector endpoint lands within a pad of a node, it attaches to that node. Attached connectors route center-to-center and clip to the node's border (AABB for rectangles, parametric for ellipses), re-routing live as you drag either node.

The engine has a focused unit-test suite (`tests/recognition.test.ts`) covering jittered rectangles, circles, elongated ellipses, straight/bowed lines, scribble rejection, size clamping, snapping, and border clipping.

### Hand-tracking input

Runs Google's **MediaPipe Hand Landmarker** in-browser (WASM), tracking up to **two hands**. A thumb↔index **pinch** is pen-down; an open hand just moves the cursor. Accuracy is the whole differentiator, so the raw landmarks get a lot of conditioning (`src/input/useHandTracking.ts`):

- **Pinch-point nib.** While pinched, the cursor is the *midpoint of thumb and index tips* — far steadier than the index tip alone, which curls and drifts as you close the pinch. The hover cursor uses the index tip and crossfades to the nib at pen-down so there's no jump.
- **Debounced pinch FSM.** Pinch engages only after two consecutive below-threshold frames and releases after two above (on top of the tight/loose **hysteresis**), killing the single-frame flicker strokes that plagued v1.
- **Jerk trimming.** The first couple of points after pen-down and the trailing points from the last ~90 ms before release are dropped — the grab and release motions distort exactly the endpoints the classifier reads.
- **Reach margin.** The central ~72% of the camera frame maps to the full canvas, so less arm travel covers more ground and the edges stay reachable.
- **Quality gating + state-aware smoothing.** Low-confidence / low-handedness frames are skipped instead of drawn through, and the **One-Euro filter** (`src/input/oneEuro.ts`) runs steadier while drawing than while hovering.
- **Hand editing.** In Select mode, pinching over a node grabs and moves it — the hand is a full pointer, not draw-only.

A small mirrored webcam preview shows both detected hand skeletons and a pen up/down indicator. If the camera is denied, missing, or the model can't load, the hand UI collapses to a quiet note and mouse + touch stay fully in control.

**Two-hand framing gesture.** Pinch with both hands at once and Plexus draws a live dashed preview of the armed palette shape (rectangle, ellipse, or diamond) spanning the two pinch points as opposite corners. Move your hands to resize it; release either pinch to commit (a min-size guard ignores accidental taps). Frame a box in the air and it exists — the signature demo.

### Editing

- **Select & move.** Click/tap to select, drag to move (attached edges follow), double-click to rename inline. Double-click an **edge** to give it a label (rendered with a paper-colored halo so it stays legible over the line).
- **Resize.** A selected node shows eight handles; drag any of them to resize (with a sensible minimum).
- **Fills.** A row of muted drafting swatches (plus white) floats by the selected node — click to fill it.
- **Alignment snapping.** While dragging, a node snaps to a neighbor's center line and a dashed accent guide shows the alignment.
- **Duplicate** (⌘/Ctrl-D) clones the selection with a small offset; **arrow keys** nudge it (1 px, or 10 px with Shift).
- **Delete/Backspace** removes the selection and its edges. Multi-level **Undo** (⌘/Ctrl-Z) and **Redo** (⌘/Ctrl-⇧-Z or ⌘/Ctrl-Y).
- **Zoom & pan.** A viewBox camera runs 25%–400%: ⌘/Ctrl +/−/0, the zoom chip bottom-right, wheel to pan, and Space- or middle-drag to pan. Air-drawn and mouse strokes both map correctly through the live camera.

### Saving & files

- **Autosave.** The document is debounced and written to `localStorage["plexus.doc.v2"]` (a versioned `{v: 2, doc}` payload); it's restored on the next visit. Corrupt or foreign data is ignored. The undo history isn't persisted.
- **Save / Open.** **Save** (⌘/Ctrl-S) downloads a `plexus.json`; **Open** (⌘/Ctrl-O) reads one back through a strict validator and loads it as an undoable action. Invalid files are rejected with a readout instead of corrupting the canvas.
- To wipe a stuck autosave, clear site data for the origin (or run `localStorage.removeItem('plexus.doc.v2')` in the console).

### Export

- **SVG** — a standalone, self-contained file with arrowhead marker defs and a padded viewBox. Rectangles, ellipses, diamonds (as `<polygon>`), text nodes (as pure `<text>`), fills, and haloed edge labels all round-trip. Opens as a clean, editable vector figure anywhere.
- **PNG** — a 2× raster snapshot. The working document itself never rasterizes.

---

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `D` | Draw mode |
| `V` / `S` | Select mode |
| `T` | Text tool — click to place a text box |
| `A` | Toggle arrowheads on new connectors |
| `⌘/Ctrl` + `Z` | Undo |
| `⌘/Ctrl` + `⇧` + `Z` / `⌘/Ctrl` + `Y` | Redo |
| `⌘/Ctrl` + `D` | Duplicate selection |
| `⌘/Ctrl` + `S` | Save diagram as JSON |
| `⌘/Ctrl` + `O` | Open a saved diagram |
| `⌘/Ctrl` + `E` | Export SVG |
| `⌘/Ctrl` + `+` / `−` / `0` | Zoom in / out / reset |
| Arrow keys | Nudge selection (`⇧` = ×10) |
| Space-drag | Pan the canvas |
| `Delete` / `Backspace` | Delete selection |
| Double-click | Edit a node or edge label |
| `?` | Shortcuts help |
| `Esc` | Deselect / close |

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
- **Autosave to `localStorage`, files on demand.** The single source of truth is still the in-memory document; a debounced copy is mirrored to `localStorage["plexus.doc.v2"]` (versioned `{v: 2, doc}`) purely so a reload doesn't lose work, and JSON save/open covers portability. No server, no account, no telemetry — nothing leaves the browser unless you Save.
- **Undo and redo are snapshot stacks** (structural sharing keeps them cheap); any new edit clears the redo stack. History is intentionally *not* persisted.
- **No backend, no keys, anywhere.** A **disabled, unwired serverless stub** lives at `api-stub/cleanup.ts.disabled`, showing where a future server-side "cleanup" key *would* live — never in the client bundle, and it stays disabled.

---

## Roadmap

Deliberately out of scope for now, in rough priority order: multi-select / marquee, curved and orthogonal edge routing, real-time collaboration, and wiring up the serverless cleanup route (the stub stays disabled until there's a reason for a server).

---

## Attribution & license

Hand tracking is powered by **Google's [MediaPipe Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker)**. MediaPipe and its models are distributed by Google under the **Apache License 2.0**; the WASM runtime (`@mediapipe/tasks-vision`) and the `hand_landmarker.task` model asset are loaded at runtime and remain the property of their authors. See the [MediaPipe repository](https://github.com/google-ai-edge/mediapipe) for full license terms.

Fonts: IBM Plex Mono and Space Grotesk, both under the SIL Open Font License, self-hosted via Fontsource.

Application code © the Plexus authors, released under the MIT License.
