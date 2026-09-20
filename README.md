# Plexus

**Live:** [plexus-olive.vercel.app](https://plexus-olive.vercel.app)

**Draw diagrams in the air.** Plexus turns rough, hand-drawn sketches into clean, editable vector figures — flowcharts, pathways, node/arrow diagrams. The primary input is *air-drawing*: track your hand with a webcam, pinch to draw. Mouse and touch work identically as a fallback.

The signature moment is the **snap** — your rough ink resolves into a crisp rectangle, ellipse, diamond, triangle, or hexagon, with a brief `recognized · …` readout. Or skip the ink entirely: **pinch both hands and frame a shape in the air**, and it exists. And in **Write mode you hand-write letters** — draw a big `A` with your mouse or your hand and Plexus types it as real text. The document stays vector the whole way through, so what you export is editable, not a screenshot.

You can also just **say it**: press `M`, say *"connect intake to review to ship"*, and the graph builds itself — laid out, labeled, and undoable in one step.

Beyond drawing, Plexus is a real editor: a seven-shape palette (including flowchart parallelograms and database cylinders), **text boxes**, resize handles, node fills, edge labels, alignment snapping, redo, duplicate, zoom/pan, autosave, a **⌘K command palette**, **dark mode**, and an interactive guided tour that advances as you actually do each step.

![Plexus is a sketch-to-clean-diagram tool with webcam hand tracking.](public/favicon.svg)

---

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
```

First visit? A **guided tour** walks you through the four core moves — and it advances itself the moment you actually do each one. (Replay it anytime from Help.)

Then any of:

- **Mouse / touch** — start drawing immediately (Draw mode is the default).
- **Shape palette** — rectangle, ellipse, diamond, triangle, hexagon, parallelogram, or cylinder, dropped at the center of the view. No drawing required.
- **Text tool** (`T`) — click anywhere to place a text box and start typing.
- **Write mode** (`W`) — hand-write letters and digits; each one is recognized and typed as clean text (see below).
- **Hand tracking** — click **Enable hand tracking** in the left rail, allow the camera, and pinch thumb-to-index to draw. Pinch **both** hands at once to frame the armed palette shape between them.
- **Voice** (`M`) — start listening and talk: *"add a box called Signal"*, *"connect signal to prep"*, *"make it blue"*, *"tidy up"*. There's a text box under the mic that runs the identical commands if you'd rather type them.
- **⌘K** — the command palette runs every action by fuzzy search.

Don't want to start from a blank page? Hit **Sample** to load a labeled pathway. Your work **autosaves** to the browser, so a reload picks up where you left off.

```bash
npm run build      # type-check + static bundle in dist/
npm run preview    # serve the built bundle locally
npm test           # recognition, state & voice unit tests (Vitest)
npm run test:e2e   # end-to-end smoke tests (Playwright)
```

---

## How it works

### Recognition engine

Every stroke — from mouse, touch, or a pinch — is an array of `{x, y}` points fed through **one** classifier (`src/recognition/classify.ts`):

1. **Closedness** — a stroke is *closed* when the gap between its first and last point is under `0.28 ×` the bounding-box diagonal **and** its path length comfortably exceeds that diagonal.
2. **Closed → node.** The stroke is resampled to a uniform ring, then:
   - **Corners** are located from a Ramer–Douglas–Peucker simplification (ε = 4.5% of the diagonal), keeping only vertices whose turning angle is 40°–145° *and* whose local "straw" (ShortStraw, Wolin et al. 2008) dips below the median. The straw test is what separates a drawn square from a circle — a circle's RDP vertices fall inside the angle window too, but their straws never dip.
   - **Radius CV** (std ÷ mean of centroid distances) measures roundness, and the **area ratio** (shoelace area ÷ bounding-box area) measures how much of its box the shape fills — a rectangle ≈ 0.95, a hexagon ≈ 0.75, a triangle or diamond ≈ 0.5.
   - It's an **ellipse** if CV < 0.19, or (≤ 2 corners and CV < 0.30). Otherwise the corner count + corner *positions* + area ratio pick between **diamond** (corners at the box's edge midpoints, half-full box), **triangle** (3 corners, half-full box), **hexagon** (4–6 corners, ~three-quarters full), and **rectangle**. A minimum size keeps tiny sketches usable. Parallelograms and cylinders are palette-only — sketched, they're indistinguishable from a rect.
3. **Open → connector.** Straightness = `distance(first, last) / pathLength`. Above 0.62 it's a connector (an **arrow** by default, toggle for a plain line); too curly, and the stroke is rejected with a subtle hint.
4. **Snapping** (`src/recognition/snap.ts`) — if a connector endpoint lands within a pad of a node, it attaches to that node. Attached connectors route center-to-center and clip to the node's border (AABB for rectangles, parametric for ellipses), re-routing live as you drag either node.

The engine has a focused unit-test suite (`tests/recognition.test.ts`) covering jittered rectangles, circles, elongated ellipses, triangles, hexagons, straight/bowed lines, scribble rejection, size clamping, snapping, and border clipping (including ray-vs-polygon for the slanted shapes).

### Write mode — handwriting recognition

Write mode (`W`) turns hand-drawn letters into typed text, using a **$P point-cloud recognizer** (Vatavu, Anthony & Wildemuth, 2012) — no ML, no network, ~40 in-repo templates (`src/recognition/glyphTemplates.ts`):

- Each finished glyph (one or more strokes) is resampled to a 32-point cloud, scaled **uniformly** (so an `I` stays thin), centered, and greedily matched against A–Z / 1–9 templates. Point clouds carry no stroke order or direction, so an `H` is an `H` no matter which line you drew first.
- A **pen-up pause (~0.65 s) commits the glyph** — that pause is what groups multi-stroke letters like A, E, H, K. Watch the HUD: each committed character flashes as it lands.
- Recognized characters build up a **text node right where you're writing**, sized to match your writing height. Gaps wider than half a letter-height become **spaces**; `Backspace` erases the last character; writing far away starts a new text node; a scribble gets `NOT A LETTER` instead of a forced guess.
- One honest ambiguity: an oval **is** an `O` — there's no `0` template (use a text box when you need a literal zero).
- The recognizer is pure and heavily unit-tested (`tests/glyph.test.ts`): every template must self-recognize under jitter and ±rotation, a circle must read as `O`, and a scribble must be rejected.

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

### Voice commands

Press `M` (or hit the mic in the rail) and talk. Speech → text uses the browser's built-in **Web Speech API**; text → diagram is Plexus's own two-tier parser (`src/voice/`). Under the mic is a **text box that runs the exact same pipeline** — it's the whole feature in Firefox, in a shared room, or when the mic is busy, and it's what the e2e suite drives.

**Tier 1 — a deterministic grammar** (`grammar.ts`). Pure, offline, instant, and the only tier most sentences need. An utterance is split into clauses (`;` `.` `and then` `next up` …, never a bare "and", so *"connect A and B"* survives), then each clause runs through ordered rules:

- **Create** — *"add three blue circles"*, *"drop a database called Store"*, *"put a diamond named Pass? below it"*. Counts, colors, ~45 shape synonyms (`box`/`rect`, `circle`/`oval`, `decision`/`diamond`, `database`/`cylinder`, `note`/`text`, …), and naming keywords (`called`, `named`, `labeled`, `saying`).
- **Connect** — *"connect intake to review to ship"* builds the whole chain, **auto-creating any node that doesn't exist yet**. Say *"link A to B with a line"* for no arrowhead, or *"connect A to B labeled retry"* for an edge label.
- **Edit** — rename, fill (*"make it orange"*), delete, select, duplicate, nudge (*"move it right"*), and **"tidy up"**.
- **App control** — undo/redo, clear, load the sample, export SVG/PNG, save, open, dark/light mode, zoom, draw/select/text/write mode, arrowheads, help.

**Tier 2 — an optional model fallback** (`api/voice.ts` + `src/voice/jev.ts`). Only the clauses tier 1 *declined* are sent, never the whole utterance, and never audio. It's off unless you set a key (below); with no key the route answers `501` once and the client latches it off for the session, so a keyless static deploy never pays for a round trip.

It is backed by [TypeSafe](https://typesafe.ai)'s **Jev**, which is not a text generator — it answers *typed questions*. That changes the shape of the problem. Rather than prompting for JSON and parsing whatever comes back, Plexus enumerates its own vocabulary as the options and asks Jev to pick:

- **The op is a `choice`, not a parse.** All 30 intents are listed with descriptions written by *meaning*, so *"it's too bright in here"* can reach `theme_dark` without sharing a word with it. `none` is always an option, so "not a command" is an answer the model can give rather than something it has to be caught doing.
- **Labels are selected, not generated.** Code extracts every plausible run of words from the utterance (`labelSpans`) and Jev picks which one is the label. The free text on your canvas therefore always comes from your own mouth, verbatim.
- **"That database thing" is a choice over your actual nodes.** Reference resolution is a question whose options are the labels currently on the canvas — strictly better than string similarity, and it cannot name a node that doesn't exist.
- **Presence and identity are asked separately.** "Did they say *which* item?" is its own yes/no, because folding it into the item list makes "the selected one" and the name of the only node on the canvas compete as if they were different answers, and an even split there reads as doubt when nothing is in doubt.
- **Uncertainty gates the command, but only where it bears weight.** Confidence is the *minimum* over the judgements the op actually rests on; a hedge about shape or colour is a harmless preference and never blocks the command, while `delete` and `clear` need a higher bar than the rest. Below the bar Plexus says *not understood* instead of guessing.

Every question is asked in one batched round trip, and whatever comes back is re-validated against the same op schema (`ops.ts` `validateOps`) **on the server and again in the browser** — this tier can only emit ops the grammar could have emitted.

Everything downstream of parsing is one pure function (`plan.ts`): ops in, a whole new `Doc` out. That buys three things worth having:

- **One utterance = one undo step**, however many nodes and edges it created (the `replace-doc` reducer action). A command that changed nothing doesn't burn an undo slot at all.
- **Placement that isn't stacked on top of itself.** New nodes are laid next to their anchor (right, then below, then left, then above) or flow into a wrapping row, always collision-checked. `tidy up` runs a layered left-to-right auto-layout (longest-path layering, two barycenter passes, orphans parked below).
- **Name resolution that forgives dictation.** Exact label → prefix → all-words-contained → shape word (*"the cylinder"*) → a gated fuzzy match. *"it"* / *"that"* means the selection, then the last thing you touched, then the newest node. Unknown names get **auto-created in a connect chain** but **refused in a delete or rename** — a misheard word should never silently destroy the wrong node.

Anything the parser can't place comes back as `not understood` in the rail rather than a guess, and problems ride along with successes (*"Added Store · no node called “stoor”"*).

Because every layer except the mic is pure, it's all testable: `tests/voice.test.ts` covers clause splitting, each rule, op validation of hostile input, placement/collision, layout, and the one-undo-entry guarantee, and the Playwright suite drives the real UI through the text box. Tier 2 is testable for the same reason — the question set and the answers → ops decoding are a pure module, so `tests/jev.test.ts` exercises the confidence gates and every branch of the decoder against recorded answer shapes, with no network and no key.

**Privacy note, stated plainly:** Chrome's Web Speech API is *server-side* — audio goes to Google, as it does for any site using it. Plexus adds nothing to that, and sends no audio anywhere itself. Tier 2, when enabled, sends only the leftover text plus your node labels to your own serverless route.

### Editing

- **Select & move.** Click/tap to select, drag to move (attached edges follow), double-click to rename inline. Double-click an **edge** to give it a label (rendered with a paper-colored halo so it stays legible over the line).
- **Resize.** A selected node shows eight handles; drag any of them to resize (with a sensible minimum).
- **Fills.** A row of muted drafting swatches (plus white) floats by the selected node — click to fill it.
- **Alignment snapping.** While dragging, a node snaps to a neighbor's center line and a dashed accent guide shows the alignment.
- **Duplicate** (⌘/Ctrl-D) clones the selection with a small offset; **arrow keys** nudge it (1 px, or 10 px with Shift).
- **Delete/Backspace** removes the selection and its edges. Multi-level **Undo** (⌘/Ctrl-Z) and **Redo** (⌘/Ctrl-⇧-Z or ⌘/Ctrl-Y).
- **Zoom & pan.** A viewBox camera runs 25%–400%: ⌘/Ctrl +/−/0, the zoom chip bottom-right, wheel to pan, and Space- or middle-drag to pan. Air-drawn and mouse strokes both map correctly through the live camera.

### Saving & files

- **Autosave.** The document is debounced and written to `localStorage["plexus.doc.v3"]` (a versioned `{v: 3, doc}` payload); it's restored on the next visit, and an old `plexus.doc.v2` autosave is read as a fallback. Corrupt or foreign data is ignored. The undo history isn't persisted.
- **Save / Open.** **Save** (⌘/Ctrl-S) downloads a `plexus.json`; **Open** (⌘/Ctrl-O) reads one back through a strict validator and loads it as an undoable action. Invalid files are rejected with a readout instead of corrupting the canvas.
- Other keys: `plexus.tour.v3` (tour completed) and `plexus.theme` (light/dark choice). To wipe everything, clear site data for the origin.

### Dark mode & the ⌘K palette

- The **sun/moon toggle** in the rail header flips between the light drafting sheet and a full dark theme; the first visit follows your system preference, and your choice persists. Unfilled nodes follow the theme (the "auto" swatch); explicit fills stay as picked. **Exports are always print-ready ink-on-white**, whatever the theme.
- **⌘/Ctrl-K** opens the command palette: every action — modes, shape inserts, export, zoom, theme, the tour — behind a fuzzy search with keyboard navigation.

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
| `W` | Write mode — hand-write letters & digits |
| `⌫` (while writing) | Erase the last written character |
| `M` | Start / stop voice commands |
| `⌘/Ctrl` + `K` | Command palette |
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

Plexus is a static single-page app. It needs no server and no keys — every feature above, voice included, works from `dist/` alone.

```bash
npm i -g vercel
vercel            # preview deploy
vercel --prod     # production
```

`vercel.json` sets the Vite framework preset and an SPA fallback rewrite (asset and `/api` requests are excluded, so hashed bundles and functions are served directly). Any static host works too — deploy the contents of `dist/`.

### Optional: the voice fallback route

`api/voice.ts` is the only server-side code in the repo, and it's **inert without a key**. Turn it on by setting one environment variable:

```bash
cp .env.example .env.local        # then paste your key in
vercel env add VOICE_API_KEY      # ...and the same for a real deploy
```

| Variable | Default | What it's for |
| --- | --- | --- |
| `VOICE_API_KEY` | *(unset → route returns `501`)* | Your [TypeSafe](https://typesafe.ai) API key |
| `VOICE_API_BASE` | `https://api.typesafe.ai` | Only worth changing to point at another environment |
| `VOICE_MODEL` | `jev-latest` | Pin a version here if you'd rather not track latest |

With a key in `.env.local`, `scripts/jev-probe.ts` runs a dozen deliberately awkward phrasings against the live model and prints the intent, the confidence, the ops, and the token cost of each. It is not part of `npm test` — the suite stays offline and free — but it's the thing to run after touching a question's wording, because wording is most of what determines whether this tier is any good:

```bash
set -a && . ./.env.local && set +a
npx vite-node scripts/jev-probe.ts
```

**Never prefix these with `VITE_`.** That's the one footgun here: a `VITE_`-prefixed variable is inlined into the client bundle and shipped to every visitor. These are read with `process.env` inside the function, so the key stays server-side. `.env.local` is gitignored.

The route caps request size (400 chars of text, 60 labels), rate-limits per instance (40/min), runs the model at `temperature: 0` with `response_format: json_object`, times out upstream at 10 s, and never forwards the provider's error body to the browser.

---

## Design decisions & defaults

Picked deliberately so the tool never blocks on a prompt:

- **Model + WASM are fetched from jsDelivr / Google's model host at runtime.** Keeps the repo slim and involves no keys. Hand tracking therefore needs a network connection the first time; drawing with mouse/touch is fully offline.
- **GPU delegate with automatic CPU fallback** for the landmarker.
- **One-Euro** (not a plain EMA) for smoothing — it's the difference between precise and laggy.
- **Handwriting is template matching, not ML.** The $P recognizer plus ~40 hand-authored glyph templates is a few hundred lines of pure TypeScript — deterministic, offline, unit-testable, and easily extended. The pen-up pause is the only glyph-grouping signal by design: geometry alone genuinely cannot tell an `H`'s second stroke from the next letter's first.
- **Autosave to `localStorage`, files on demand.** The single source of truth is still the in-memory document; a debounced copy is mirrored to `localStorage["plexus.doc.v3"]` (versioned `{v: 3, doc}`) purely so a reload doesn't lose work, and JSON save/open covers portability. No server, no account, no telemetry — nothing leaves the browser unless you Save.
- **Undo and redo are snapshot stacks** (structural sharing keeps them cheap); any new edit clears the redo stack. History is intentionally *not* persisted.
- **Voice is deterministic first, a model second.** A grammar you can read, test, and predict handles the sentences people actually say; the model route exists only to catch the long tail, is optional, and can only return ops the grammar could have returned. Nothing about the feature degrades when the route is off — it's *additive*, which is the only honest way to depend on a model.
- **Where a model is used, it selects rather than writes.** Every value tier 2 can produce is one the code enumerated first — an intent from a fixed list, a colour from the palette, a node from the canvas, a label from the user's own words. There is no step where prose has to be parsed back into structure and no string the model authored, so the failure mode is "picked the wrong option", which confidence can gate, rather than "emitted something unparseable", which it can't.
- **Voice mutations are one pure function.** `planOps(ops, ctx) → Doc` means an utterance is atomic: one undo entry, no half-applied command, and the whole thing is unit-testable without a browser, a microphone, or React.
- **No keys in the client bundle, ever.** The one serverless function (`api/voice.ts`) reads its key from `process.env` and is inert without it; nothing is `VITE_`-prefixed. A second **disabled, unwired stub** lives at `api-stub/cleanup.ts.disabled`, showing where a future server-side "cleanup" key *would* live — it stays disabled.

---

## Roadmap

Deliberately out of scope for now, in rough priority order: lowercase / cursive handwriting, multi-select / marquee, curved and orthogonal edge routing, real-time collaboration, and wiring up the serverless cleanup route (the stub stays disabled until there's a reason for a server).

---

## Attribution & license

Hand tracking is powered by **Google's [MediaPipe Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker)**. MediaPipe and its models are distributed by Google under the **Apache License 2.0**; the WASM runtime (`@mediapipe/tasks-vision`) and the `hand_landmarker.task` model asset are loaded at runtime and remain the property of their authors. See the [MediaPipe repository](https://github.com/google-ai-edge/mediapipe) for full license terms.

Fonts: IBM Plex Mono and Space Grotesk, both under the SIL Open Font License, self-hosted via Fontsource.

Application code © the Plexus authors, released under the MIT License.
