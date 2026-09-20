import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Canvas, ZOOM_MAX, ZOOM_MIN, type FramePreview, type Mode, type ViewState } from "./components/Canvas";
import { Toolbar, type PaletteShape } from "./components/Toolbar";
import { Hud, type HudReadout } from "./components/Hud";
import { CameraPanel } from "./components/CameraPanel";
import { VoicePanel } from "./components/VoicePanel";
import { Tour, TOUR_KEY, type TourSnapshot } from "./components/Tour";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { HelpModal } from "./components/HelpModal";
import { docReducer, initialDocState, type DocState } from "./state/doc";
import { uid } from "./state/uid";
import { downloadDocJson, loadLocal, parseDocJson, saveLocal } from "./state/persist";
import { useStrokeInput, type RecognitionEvent } from "./input/useStrokeInput";
import { useWriteComposer } from "./input/useWriteComposer";
import { useHandTracking, type HandApi } from "./input/useHandTracking";
import { cameraToScene } from "./input/cameraMap";
import { downloadSvg } from "./export/svg";
import { downloadPng } from "./export/png";
import { MoonIcon, SunIcon } from "./components/icons";
import { usePrefersReducedMotion } from "./input/usePrefersReducedMotion";
import { planOps, type Effect } from "./voice/plan";
import { useVoice, type VoiceApply } from "./voice/useVoice";
import { DEFAULT_NODE_SIZE, type Doc, type NodeType, type Point } from "./types";

const GHOST_MS = 240;
const SNAP_MS = 460;
const READOUT_MS = 1500;
const AUTOSAVE_MS = 800;
const NUDGE_BURST_MS = 500;

/** Minimum size for a two-hand framed shape to count as intentional. */
const FRAME_MIN = { w: 48, h: 36 } as const;

const SHAPE_LABEL: Record<NodeType, string> = {
  rect: "RECTANGLE",
  ellipse: "ELLIPSE",
  diamond: "DIAMOND",
  triangle: "TRIANGLE",
  hexagon: "HEXAGON",
  parallelogram: "PARALLELOGRAM",
  cylinder: "CYLINDER",
  text: "TEXT",
};

/** Default sizes for palette inserts (also seeds the two-hand frame preview). */
const { text: _textSize, ...INSERT_SIZE } = DEFAULT_NODE_SIZE;

function initState(base: DocState): DocState {
  const restored = loadLocal();
  return restored ? { ...base, doc: restored } : base;
}

export type Theme = "light" | "dark";

/** The pre-paint script in index.html already set data-theme; read it back. */
function initTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  return t === "dark" ? "dark" : "light";
}

export function App() {
  const [state, dispatch] = useReducer(docReducer, initialDocState, initState);
  const [mode, setMode] = useState<Mode>("draw");
  const [arrow, setArrow] = useState(true);
  const [shape, setShape] = useState<PaletteShape>("rect");
  const [view, setView] = useState<ViewState>({ x: 0, y: 0, z: 1 });
  const [readout, setReadout] = useState<HudReadout | null>(null);
  const [ghost, setGhost] = useState<ReadonlyArray<readonly Point[]> | null>(null);
  const [justAddedId, setJustAddedId] = useState<string | null>(null);
  const [framePreview, setFramePreview] = useState<FramePreview | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [glyphCount, setGlyphCount] = useState(0);
  const [tourOpen, setTourOpen] = useState<boolean>(() => {
    try {
      return (
        localStorage.getItem(TOUR_KEY) !== "done" &&
        state.doc.nodes.length === 0 &&
        state.doc.edges.length === 0
      );
    } catch {
      return false;
    }
  });
  const [theme, setTheme] = useState<Theme>(initTheme);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("plexus.theme", theme);
    } catch {
      /* storage disabled — theme just won't persist */
    }
  }, [theme]);

  const stageRef = useRef<HTMLElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const nodesRef = useRef(state.doc.nodes);
  nodesRef.current = state.doc.nodes;
  const docRef = useRef(state.doc);
  docRef.current = state.doc;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const arrowRef = useRef(arrow);
  arrowRef.current = arrow;
  const shapeRef = useRef(shape);
  shapeRef.current = shape;
  const viewRef = useRef(view);
  viewRef.current = view;
  const selectionRef = useRef(state.selection);
  selectionRef.current = state.selection;

  const nonce = useRef(0);
  const timers = useRef<number[]>([]);
  useEffect(() => {
    const t = timers.current;
    return () => t.forEach(clearTimeout);
  }, []);

  // ----- autosave (debounced; best-effort) -----
  useEffect(() => {
    const t = window.setTimeout(() => saveLocal(state.doc), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [state.doc]);

  // ----- HUD + snap-in flash helpers -----
  const flash = useCallback((label: string, tone: "ok" | "warn") => {
    nonce.current += 1;
    const myNonce = nonce.current;
    setReadout({ label, tone, nonce: myNonce });
    timers.current.push(
      window.setTimeout(() => {
        setReadout((cur) => (cur && cur.nonce === myNonce ? null : cur));
      }, READOUT_MS),
    );
  }, []);

  const pulse = useCallback((id: string) => {
    setJustAddedId(id);
    timers.current.push(
      window.setTimeout(() => setJustAddedId((cur) => (cur === id ? null : cur)), SNAP_MS),
    );
  }, []);

  const ghostInk = useCallback((strokes: ReadonlyArray<readonly Point[]>) => {
    setGhost(strokes);
    timers.current.push(window.setTimeout(() => setGhost((cur) => (cur === strokes ? null : cur)), GHOST_MS));
  }, []);

  const markAdded = useCallback(
    (id: string, stroke: readonly Point[] | null) => {
      pulse(id);
      if (stroke) ghostInk([stroke]);
    },
    [pulse, ghostInk],
  );

  const onResult = useCallback(
    (ev: RecognitionEvent) => {
      const rec = ev.recognition;
      if (rec.kind === "node") flash(SHAPE_LABEL[rec.type], "ok");
      else if (rec.kind === "edge") flash(arrowRef.current ? "ARROW" : "LINE", "ok");
      else if (rec.reason === "too-curly") flash("NO CLEAN SHAPE", "warn");
      else if (rec.reason === "self-edge") flash("SELF-LOOP SKIPPED", "warn");
      if (ev.addedId) markAdded(ev.addedId, ev.stroke);
    },
    [flash, markAdded],
  );

  // ----- write mode: glyph composition -----
  const onGlyph = useCallback(
    (char: string | null, strokes: ReadonlyArray<readonly Point[]>) => {
      if (char) {
        flash(`“${char}”`, "ok");
        setGlyphCount((n) => n + 1);
      } else {
        flash("NOT A LETTER", "warn");
      }
      ghostInk(strokes);
    },
    [flash, ghostInk],
  );

  const composer = useWriteComposer({ dispatch, onGlyph, onNodePulse: pulse });
  const composerRef = useRef(composer);
  composerRef.current = composer;

  const writeRef = useRef(false);
  writeRef.current = mode === "write";

  const input = useStrokeInput({
    dispatch,
    nodesRef,
    arrowRef,
    onResult,
    writeRef,
    onWriteStroke: composer.onStroke,
  });

  // Leaving Write mode commits any pending ink so nothing silently vanishes.
  const prevModeRef = useRef(mode);
  useEffect(() => {
    if (prevModeRef.current === "write" && mode !== "write") composerRef.current.flush();
    prevModeRef.current = mode;
  }, [mode]);

  // ----- hand-tracking bridge -----
  const grabRef = useRef<{ id: string; dx: number; dy: number } | null>(null);

  const mapToScene = useCallback((nx: number, ny: number): Point => {
    const rect = stageRef.current?.getBoundingClientRect();
    const v = viewRef.current;
    return cameraToScene(nx, ny, {
      x: v.x,
      y: v.y,
      w: (rect?.width ?? 1000) / v.z,
      h: (rect?.height ?? 700) / v.z,
    });
  }, []);

  const pinchSelectStart = useCallback((p: Point): boolean => {
    const nodes = nodesRef.current;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i]!;
      if (p.x >= n.x && p.x <= n.x + n.w && p.y >= n.y && p.y <= n.y + n.h) {
        dispatch({ type: "start-move", id: n.id });
        grabRef.current = { id: n.id, dx: p.x - n.x, dy: p.y - n.y };
        return true;
      }
    }
    return false;
  }, []);

  const pinchSelectMove = useCallback((p: Point) => {
    const g = grabRef.current;
    if (g) dispatch({ type: "move-node", id: g.id, x: p.x - g.dx, y: p.y - g.dy });
  }, []);

  const pinchSelectEnd = useCallback(() => {
    grabRef.current = null;
  }, []);

  const frameUpdate = useCallback((a: Point, b: Point) => {
    setFramePreview({
      type: shapeRef.current,
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(a.x - b.x),
      h: Math.abs(a.y - b.y),
    });
  }, []);

  const frameCommit = useCallback(
    (a: Point, b: Point) => {
      setFramePreview(null);
      const w = Math.abs(a.x - b.x);
      const h = Math.abs(a.y - b.y);
      if (w < FRAME_MIN.w || h < FRAME_MIN.h) {
        flash("FRAME TOO SMALL", "warn");
        return;
      }
      const id = uid("n");
      dispatch({
        type: "add-node",
        node: {
          id,
          type: shapeRef.current,
          x: Math.min(a.x, b.x),
          y: Math.min(a.y, b.y),
          w,
          h,
          label: "",
        },
      });
      flash(`${SHAPE_LABEL[shapeRef.current]} · FRAMED`, "ok");
      markAdded(id, null);
    },
    [flash, markAdded],
  );

  const frameCancel = useCallback(() => setFramePreview(null), []);

  const handApi: HandApi = {
    mapToScene,
    pinchSelectStart,
    pinchSelectMove,
    pinchSelectEnd,
    frameUpdate,
    frameCommit,
    frameCancel,
  };
  const handApiRef = useRef(handApi);
  handApiRef.current = handApi;

  const hand = useHandTracking({ input, mode, api: handApiRef.current });

  // ----- toolbar actions -----
  const exportSvgAction = useCallback(() => downloadSvg(state.doc), [state.doc]);
  const exportPngAction = useCallback(() => void downloadPng(state.doc), [state.doc]);
  const saveAction = useCallback(() => downloadDocJson(state.doc), [state.doc]);

  const openAction = useCallback(() => fileRef.current?.click(), []);
  const onFileChosen = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      const doc = parseDocJson(await file.text());
      if (doc) {
        dispatch({ type: "load-doc", doc });
        flash("DIAGRAM LOADED", "ok");
      } else {
        flash("INVALID FILE", "warn");
      }
    },
    [flash],
  );

  const insertShape = useCallback(
    (type: PaletteShape) => {
      setShape(type);
      const rect = stageRef.current?.getBoundingClientRect();
      const v = viewRef.current;
      const cx = v.x + (rect?.width ?? 1000) / (2 * v.z);
      const cy = v.y + (rect?.height ?? 700) / (2 * v.z);
      const size = INSERT_SIZE[type];
      const id = uid("n");
      dispatch({
        type: "add-node",
        node: { id, type, x: cx - size.w / 2, y: cy - size.h / 2, w: size.w, h: size.h, label: "" },
        select: true,
      });
      setMode("select");
      markAdded(id, null);
    },
    [markAdded],
  );

  const zoomBy = useCallback((factor: number) => {
    setView((v) => {
      const rect = stageRef.current?.getBoundingClientRect();
      const w = rect?.width ?? 1000;
      const h = rect?.height ?? 700;
      const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, factor === 0 ? 1 : v.z * factor));
      const cx = v.x + w / (2 * v.z);
      const cy = v.y + h / (2 * v.z);
      return { x: cx - w / (2 * z), y: cy - h / (2 * z), z };
    });
  }, []);

  const duplicateSelection = useCallback(() => {
    const sel = selectionRef.current;
    if (!sel || sel.kind !== "node") return;
    const node = nodesRef.current.find((n) => n.id === sel.id);
    if (!node) return;
    const id = uid("n");
    dispatch({ type: "add-node", node: { ...node, id, x: node.x + 24, y: node.y + 24 }, select: true });
    markAdded(id, null);
  }, [markAdded]);

  // ----- voice commands -----
  /** Everything a plan asks for that is not a document edit. */
  const runEffect = useCallback(
    (fx: Effect, doc: Doc) => {
      switch (fx.kind) {
        case "mode":
          setMode(fx.mode);
          return;
        case "arrows":
          setArrow(fx.on);
          return;
        case "theme":
          setTheme(fx.theme);
          return;
        case "zoom":
          zoomBy(fx.dir === "in" ? 1.2 : fx.dir === "out" ? 1 / 1.2 : 0);
          return;
        case "export":
          if (fx.format === "svg") downloadSvg(doc);
          else void downloadPng(doc);
          return;
        case "file":
          if (fx.action === "save") downloadDocJson(doc);
          else openAction();
          return;
        case "history":
          dispatch({ type: fx.action });
          return;
        case "canvas":
          dispatch({ type: fx.action === "clear" ? "clear" : "load-sample" });
          return;
        case "help":
          setHelpOpen(true);
          return;
      }
    },
    [zoomBy, openAction],
  );

  const voiceApply = useCallback<VoiceApply>(
    (ops) => {
      const before = docRef.current;
      const plan = planOps(ops, {
        doc: before,
        selection: selectionRef.current,
        arrowDefault: arrowRef.current,
        newId: uid,
      });

      if (plan.doc !== before || plan.selection !== selectionRef.current) {
        dispatch({ type: "replace-doc", doc: plan.doc, selection: plan.selection });
      }
      // Anything newly created is there to be edited, so surface the handles —
      // but only before effects run, so an explicit "draw mode" still wins.
      if (plan.added.length > 0) setMode("select");
      for (const fx of plan.effects) runEffect(fx, plan.doc);
      for (const id of plan.added) pulse(id);

      const ok = plan.problems.length === 0 && plan.notes.length > 0;
      const detail =
        plan.notes.length > 0
          ? [...plan.notes, ...plan.problems].join(" · ")
          : plan.problems.join(" · ") || "nothing to do";
      flash(detail.toUpperCase(), ok ? "ok" : "warn");
      return { ok, detail };
    },
    [flash, pulse, runEffect],
  );

  const voiceLabels = useCallback(
    () => docRef.current.nodes.map((n) => n.label.trim()).filter((l) => l !== ""),
    [],
  );

  const voice = useVoice({ apply: voiceApply, labels: voiceLabels });
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  // ----- keyboard shortcuts -----
  const nudgeAt = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (typing) return; // the label editor handles (and stops) its own keys
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      if (helpOpen && e.key === "Escape") {
        setHelpOpen(false);
        return;
      }

      if (mod) {
        if (key === "k") {
          e.preventDefault();
          setPaletteOpen((v) => !v);
        } else if (key === "z") {
          e.preventDefault();
          dispatch({ type: e.shiftKey ? "redo" : "undo" });
        } else if (key === "y") {
          e.preventDefault();
          dispatch({ type: "redo" });
        } else if (key === "e") {
          e.preventDefault();
          exportSvgAction();
        } else if (key === "s") {
          e.preventDefault();
          saveAction();
        } else if (key === "o") {
          e.preventDefault();
          openAction();
        } else if (key === "d") {
          e.preventDefault();
          duplicateSelection();
        } else if (key === "=" || key === "+") {
          e.preventDefault();
          zoomBy(1.2);
        } else if (key === "-") {
          e.preventDefault();
          zoomBy(1 / 1.2);
        } else if (key === "0") {
          e.preventDefault();
          zoomBy(0);
        }
        return;
      }

      if (e.key === "?") {
        setHelpOpen((v) => !v);
        return;
      }
      if (key === "d") setMode("draw");
      else if (key === "v" || key === "s") setMode("select");
      else if (key === "t") setMode("text");
      else if (key === "w") setMode("write");
      else if (key === "a") setArrow((v) => !v);
      else if (key === "m") voiceRef.current.toggle();
      else if (e.key === "Delete" || e.key === "Backspace") {
        // While composing in Write mode, Backspace erases the last character.
        if (e.key === "Backspace" && modeRef.current === "write" && composerRef.current.backspace()) {
          e.preventDefault();
          return;
        }
        if (selectionRef.current) {
          e.preventDefault();
          dispatch({ type: "delete-selection" });
        }
      } else if (e.key.startsWith("Arrow")) {
        const sel = selectionRef.current;
        if (!sel || sel.kind !== "node") return;
        const node = nodesRef.current.find((n) => n.id === sel.id);
        if (!node) return;
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        const now = e.timeStamp;
        if (now - nudgeAt.current > NUDGE_BURST_MS) dispatch({ type: "start-move", id: node.id });
        nudgeAt.current = now;
        dispatch({ type: "move-node", id: node.id, x: node.x + dx, y: node.y + dy });
      } else if (e.key === "Escape") {
        if (helpOpen) setHelpOpen(false);
        else if (modeRef.current === "write" && composerRef.current.composing) composerRef.current.flush();
        else dispatch({ type: "select", selection: null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [helpOpen, exportSvgAction, saveAction, openAction, duplicateSelection, zoomBy]);

  // ----- onboarding tour: live snapshot the steps watch -----
  const labeledCount = useMemo(
    () =>
      state.doc.nodes.filter((n) => n.label.trim() !== "").length +
      state.doc.edges.filter((e) => (e.label ?? "").trim() !== "").length,
    [state.doc],
  );
  const tourSnap: TourSnapshot = {
    nodes: state.doc.nodes.length,
    edges: state.doc.edges.length,
    labeled: labeledCount,
    glyphs: glyphCount,
    commands: voice.ran,
    handRunning: hand.status === "running",
  };

  // ----- ⌘K command registry (one list; the palette fuzzy-filters it) -----
  const commands: Command[] = [
    { id: "mode-draw", section: "Mode", title: "Draw", hint: "D", keywords: "sketch pen", run: () => setMode("draw") },
    { id: "mode-select", section: "Mode", title: "Select & move", hint: "V", keywords: "cursor arrange", run: () => setMode("select") },
    { id: "mode-text", section: "Mode", title: "Text tool", hint: "T", keywords: "textbox type", run: () => setMode("text") },
    { id: "mode-write", section: "Mode", title: "Write — hand-write letters", hint: "W", keywords: "handwriting glyph letters", run: () => setMode("write") },
    ...(Object.keys(INSERT_SIZE) as Array<keyof typeof INSERT_SIZE>).map((t) => ({
      id: `insert-${t}`,
      section: "Insert",
      title: `Insert ${t === "rect" ? "rectangle" : t}`,
      keywords: `shape add ${t === "cylinder" ? "database db" : t === "diamond" ? "decision" : t === "parallelogram" ? "input output io" : ""}`,
      run: () => insertShape(t),
    })),
    { id: "arrows", section: "Edge", title: arrow ? "Switch to plain lines" : "Switch to arrows", hint: "A", keywords: "arrowheads connector toggle", run: () => setArrow((v) => !v) },
    { id: "undo", section: "History", title: "Undo", hint: "⌘Z", run: () => dispatch({ type: "undo" }) },
    { id: "redo", section: "History", title: "Redo", hint: "⌘⇧Z", run: () => dispatch({ type: "redo" }) },
    { id: "duplicate", section: "History", title: "Duplicate selection", hint: "⌘D", keywords: "copy clone", run: duplicateSelection },
    { id: "zoom-in", section: "View", title: "Zoom in", hint: "⌘+", run: () => zoomBy(1.2) },
    { id: "zoom-out", section: "View", title: "Zoom out", hint: "⌘−", run: () => zoomBy(1 / 1.2) },
    { id: "zoom-reset", section: "View", title: "Reset zoom", hint: "⌘0", keywords: "100%", run: () => zoomBy(0) },
    { id: "theme", section: "View", title: theme === "dark" ? "Switch to light theme" : "Switch to dark theme", keywords: "dark light mode night", run: () => setTheme((t) => (t === "dark" ? "light" : "dark")) },
    { id: "save", section: "File", title: "Save diagram as JSON", hint: "⌘S", keywords: "download export", run: saveAction },
    { id: "open", section: "File", title: "Open a saved diagram", hint: "⌘O", keywords: "load import json", run: openAction },
    { id: "export-svg", section: "File", title: "Export SVG", hint: "⌘E", keywords: "vector download", run: exportSvgAction },
    { id: "export-png", section: "File", title: "Export PNG", keywords: "raster image download", run: exportPngAction },
    { id: "clear", section: "File", title: "Clear canvas", keywords: "delete everything reset", run: () => dispatch({ type: "clear" }) },
    { id: "sample", section: "File", title: "Load sample pathway", keywords: "demo example", run: () => dispatch({ type: "load-sample" }) },
    {
      id: "voice",
      section: "Voice",
      title: voice.listening ? "Stop listening" : "Start listening",
      hint: "M",
      keywords: "speech microphone dictate say talk",
      run: voice.toggle,
    },
    { id: "tidy", section: "Voice", title: "Tidy the layout", keywords: "arrange auto layout organise align", run: () => void voice.run("tidy up") },
    {
      id: "voice-local",
      section: "Voice",
      title:
        voice.local.status === "off" || voice.local.status === "failed"
          ? "Understand loose phrasing — download the model (~30 MB)"
          : "Understand loose phrasing — turn off",
      keywords: "ai model offline free local embedding natural language understand",
      run: () => voice.setLocal(voice.local.status === "off" || voice.local.status === "failed"),
    },
    { id: "tour", section: "Help", title: "Replay the guided tour", keywords: "onboarding tutorial", run: () => setTourOpen(true) },
    { id: "help", section: "Help", title: "Keyboard shortcuts", hint: "?", keywords: "keys reference", run: () => setHelpOpen(true) },
  ];

  return (
    <div className="app">
      <aside className="rail">
        <header className="brand">
          <span className="brand__mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="26" height="26">
              <circle cx="10" cy="21" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
              <rect x="18" y="6" width="9" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M13 18 L19 13" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </span>
          <span className="brand__word">
            Plexus
            <small>sketch → clean</small>
          </span>
          <button
            type="button"
            className="theme-toggle"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
        </header>

        <Toolbar
          mode={mode}
          onMode={setMode}
          shape={shape}
          onInsertShape={insertShape}
          arrow={arrow}
          onArrow={setArrow}
          canUndo={state.past.length > 0}
          canRedo={state.future.length > 0}
          onUndo={() => dispatch({ type: "undo" })}
          onRedo={() => dispatch({ type: "redo" })}
          onClear={() => dispatch({ type: "clear" })}
          onSave={saveAction}
          onOpen={openAction}
          onExportSvg={exportSvgAction}
          onExportPng={exportPngAction}
          onLoadSample={() => dispatch({ type: "load-sample" })}
          onHelp={() => setHelpOpen(true)}
        />

        <div className="rail__spacer" />

        <div data-tour="voice">
          <VoicePanel voice={voice} />
        </div>

        <div data-tour="camera">
          <CameraPanel hand={hand} />
        </div>
      </aside>

      <main className="stage" ref={stageRef} data-tour="canvas">
        <Canvas
          doc={state.doc}
          selection={state.selection}
          mode={mode}
          input={input}
          dispatch={dispatch}
          ghost={ghost}
          writeBuffer={composer.buffer}
          writeGuide={composer.guide}
          justAddedId={justAddedId}
          cursor={hand.status === "running" ? hand.cursor : null}
          cursor2={hand.status === "running" ? hand.cursor2 : null}
          penDown={hand.penDown}
          framePreview={framePreview}
          view={view}
          onViewChange={setView}
          onRequestMode={setMode}
          reducedMotion={reducedMotion}
        />

        <div className="status" aria-hidden="true">
          {mode.toUpperCase()} · {arrow ? "ARROWS" : "LINES"} · {Math.round(view.z * 100)}%
        </div>

        <div className="zoom">
          <button type="button" className="zoom__btn" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">
            −
          </button>
          <button type="button" className="zoom__pct" onClick={() => zoomBy(0)} title="Reset zoom (⌘/Ctrl-0)">
            {Math.round(view.z * 100)}%
          </button>
          <button type="button" className="zoom__btn" onClick={() => zoomBy(1.2)} aria-label="Zoom in">
            +
          </button>
        </div>

        <Hud readout={readout} reducedMotion={reducedMotion} />
      </main>

      {helpOpen && (
        <HelpModal
          onClose={() => setHelpOpen(false)}
          onReplayTour={() => {
            setHelpOpen(false);
            setTourOpen(true);
          }}
        />
      )}

      {tourOpen && <Tour snap={tourSnap} reducedMotion={reducedMotion} onClose={() => setTourOpen(false)} />}

      {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}

      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={(e) => void onFileChosen(e)}
        aria-hidden="true"
        tabIndex={-1}
      />
    </div>
  );
}
