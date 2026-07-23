import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Canvas, type Mode } from "./components/Canvas";
import { Toolbar } from "./components/Toolbar";
import { Hud, type HudReadout } from "./components/Hud";
import { CameraPanel } from "./components/CameraPanel";
import { docReducer, initialDocState } from "./state/doc";
import { useStrokeInput, type RecognitionEvent } from "./input/useStrokeInput";
import { useHandTracking } from "./input/useHandTracking";
import { downloadSvg } from "./export/svg";
import { downloadPng } from "./export/png";
import { usePrefersReducedMotion } from "./input/usePrefersReducedMotion";
import type { Point } from "./types";

const GHOST_MS = 240;
const SNAP_MS = 460;
const READOUT_MS = 1500;

function readoutFor(ev: RecognitionEvent, arrow: boolean): HudReadout | null {
  const rec = ev.recognition;
  if (rec.kind === "node") {
    return { label: rec.type === "ellipse" ? "ELLIPSE" : "RECTANGLE", tone: "ok", nonce: 0 };
  }
  if (rec.kind === "edge") {
    return { label: arrow ? "ARROW" : "LINE", tone: "ok", nonce: 0 };
  }
  if (rec.reason === "too-curly") {
    return { label: "NO CLEAN SHAPE", tone: "warn", nonce: 0 };
  }
  return null; // ignore accidental taps silently
}

export function App() {
  const [state, dispatch] = useReducer(docReducer, initialDocState);
  const [mode, setMode] = useState<Mode>("draw");
  const [arrow, setArrow] = useState(true);
  const [readout, setReadout] = useState<HudReadout | null>(null);
  const [ghost, setGhost] = useState<readonly Point[] | null>(null);
  const [justAddedId, setJustAddedId] = useState<string | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  const nodesRef = useRef(state.doc.nodes);
  nodesRef.current = state.doc.nodes;
  const arrowRef = useRef(arrow);
  arrowRef.current = arrow;

  const nonce = useRef(0);
  const timers = useRef<number[]>([]);
  useEffect(() => {
    const t = timers.current;
    return () => t.forEach(clearTimeout);
  }, []);

  const onResult = useCallback(
    (ev: RecognitionEvent) => {
      const r = readoutFor(ev, arrowRef.current ?? true);
      if (r) {
        nonce.current += 1;
        setReadout({ ...r, nonce: nonce.current });
        const t = window.setTimeout(() => {
          setReadout((cur) => (cur && cur.nonce === nonce.current ? null : cur));
        }, READOUT_MS);
        timers.current.push(t);
      }
      if (ev.addedId) {
        setJustAddedId(ev.addedId);
        setGhost(ev.stroke);
        timers.current.push(
          window.setTimeout(() => setGhost(null), GHOST_MS),
          window.setTimeout(() => setJustAddedId((cur) => (cur === ev.addedId ? null : cur)), SNAP_MS),
        );
      }
    },
    [],
  );

  const input = useStrokeInput({ dispatch, nodesRef, arrowRef, onResult });

  const stageRef = useRef<HTMLElement | null>(null);
  const hand = useHandTracking({ input, mode, stageRef });

  const exportSvg = useCallback(() => downloadSvg(state.doc), [state.doc]);
  const exportPng = useCallback(() => void downloadPng(state.doc), [state.doc]);

  // Global keyboard shortcuts. Skip when typing in the inline label editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        dispatch({ type: "undo" });
        return;
      }
      if (mod && e.key.toLowerCase() === "e") {
        e.preventDefault();
        exportSvg();
        return;
      }
      if (typing) return;
      if (mod) return;

      if (e.key === "d" || e.key === "D") setMode("draw");
      else if (e.key === "v" || e.key === "V" || e.key === "s" || e.key === "S") setMode("select");
      else if (e.key === "a" || e.key === "A") setArrow((v) => !v);
      else if (e.key === "Delete" || e.key === "Backspace") {
        if (state.selection) {
          e.preventDefault();
          dispatch({ type: "delete-selection" });
        }
      } else if (e.key === "Escape") {
        dispatch({ type: "select", selection: null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exportSvg, state.selection]);

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
          arrow={arrow}
          onArrow={setArrow}
          canUndo={state.past.length > 0}
          onUndo={() => dispatch({ type: "undo" })}
          onClear={() => dispatch({ type: "clear" })}
          onExportSvg={exportSvg}
          onExportPng={exportPng}
          onLoadSample={() => dispatch({ type: "load-sample" })}
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
          penDown={hand.penDown}
          reducedMotion={reducedMotion}
        />
        <Hud readout={readout} reducedMotion={reducedMotion} />
      </main>
    </div>
  );
}
