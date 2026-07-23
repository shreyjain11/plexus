import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Canvas, ZOOM_MAX, ZOOM_MIN, type FramePreview, type Mode, type ViewState } from "./components/Canvas";
import { Toolbar, type PaletteShape } from "./components/Toolbar";
import { Hud, type HudReadout } from "./components/Hud";
import { CameraPanel } from "./components/CameraPanel";
import { Coach } from "./components/Coach";
import { HelpModal } from "./components/HelpModal";
import { docReducer, initialDocState, type DocState } from "./state/doc";
import { uid } from "./state/uid";
import { downloadDocJson, loadLocal, parseDocJson, saveLocal } from "./state/persist";
import { useStrokeInput, type RecognitionEvent } from "./input/useStrokeInput";
import { useHandTracking, type HandApi } from "./input/useHandTracking";
import { cameraToScene } from "./input/cameraMap";
import { downloadSvg } from "./export/svg";
import { downloadPng } from "./export/png";
import { usePrefersReducedMotion } from "./input/usePrefersReducedMotion";
import type { NodeType, Point } from "./types";

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
  text: "TEXT",
};

function initState(base: DocState): DocState {
  const restored = loadLocal();
  return restored ? { ...base, doc: restored } : base;
}

export function App() {
  const [state, dispatch] = useReducer(docReducer, initialDocState, initState);
  const [mode, setMode] = useState<Mode>("draw");
  const [arrow, setArrow] = useState(true);
  const [shape, setShape] = useState<PaletteShape>("rect");
  const [view, setView] = useState<ViewState>({ x: 0, y: 0, z: 1 });
  const [readout, setReadout] = useState<HudReadout | null>(null);
  const [ghost, setGhost] = useState<readonly Point[] | null>(null);
  const [justAddedId, setJustAddedId] = useState<string | null>(null);
  const [framePreview, setFramePreview] = useState<FramePreview | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [coachDismissed, setCoachDismissed] = useState(false);
  const reducedMotion = usePrefersReducedMotion();

  const stageRef = useRef<HTMLElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const nodesRef = useRef(state.doc.nodes);
  nodesRef.current = state.doc.nodes;
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

  const markAdded = useCallback((id: string, stroke: readonly Point[] | null) => {
    setJustAddedId(id);
    if (stroke) {
      setGhost(stroke);
      timers.current.push(window.setTimeout(() => setGhost((cur) => (cur === stroke ? null : cur)), GHOST_MS));
    }
    timers.current.push(
      window.setTimeout(() => setJustAddedId((cur) => (cur === id ? null : cur)), SNAP_MS),
    );
  }, []);

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

  const input = useStrokeInput({ dispatch, nodesRef, arrowRef, onResult });

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
      const size = type === "diamond" ? { w: 170, h: 104 } : type === "ellipse" ? { w: 150, h: 96 } : { w: 160, h: 100 };
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
        if (key === "z") {
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
      else if (key === "a") setArrow((v) => !v);
      else if (e.key === "Delete" || e.key === "Backspace") {
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
        else dispatch({ type: "select", selection: null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [helpOpen, exportSvgAction, saveAction, openAction, duplicateSelection, zoomBy]);

  const docEmpty = state.doc.nodes.length === 0 && state.doc.edges.length === 0;

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

        <CameraPanel hand={hand} />
      </aside>

      <main className="stage" ref={stageRef}>
        <Canvas
          doc={state.doc}
          selection={state.selection}
          mode={mode}
          input={input}
          dispatch={dispatch}
          ghost={ghost}
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

        {docEmpty && !coachDismissed && <Coach onDismiss={() => setCoachDismissed(true)} />}

        <Hud readout={readout} reducedMotion={reducedMotion} />
      </main>

      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}

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
