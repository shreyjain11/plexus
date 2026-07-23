import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DiagramEdge, DiagramNode, Doc, NodeType, Point } from "../types";
import { minSizeFor } from "../types";
import type { DocAction, Selection } from "../state/doc";
import type { StrokeInput } from "../input/useStrokeInput";
import { routeEdge, snapToAlignment } from "../recognition/snap";
import { cylinderCapRy, cylinderPath, shapePoints } from "../geometry/shapes";
import { uid } from "../state/uid";

export type Mode = "draw" | "select" | "text" | "write";

export interface ViewState {
  /** Scene coordinate at the viewport's top-left. */
  x: number;
  y: number;
  /** Zoom factor: scene units × z = css pixels. */
  z: number;
}

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;

export interface FramePreview {
  type: NodeType;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** "" = auto: no stored fill, so the node follows the theme's --node-fill. */
export const FILL_SWATCHES = [
  "",
  "#eef2fb",
  "#e8f1ec",
  "#fdf2e7",
  "#f7ebee",
  "#eeeaf6",
  "#f0f0ee",
] as const;

interface CanvasProps {
  doc: Doc;
  selection: Selection | null;
  mode: Mode;
  input: StrokeInput;
  dispatch: React.Dispatch<DocAction>;
  /** Raw ink fading out as recognized content snaps in (one path per stroke). */
  ghost: ReadonlyArray<readonly Point[]> | null;
  /** Write mode: pen-up strokes of the glyph awaiting its commit pause. */
  writeBuffer: ReadonlyArray<readonly Point[]>;
  /** Write mode: dashed baseline under the active composition. */
  writeGuide: { x1: number; x2: number; y: number } | null;
  justAddedId: string | null;
  cursor: Point | null;
  cursor2: Point | null;
  penDown: boolean;
  framePreview: FramePreview | null;
  view: ViewState;
  onViewChange: (v: ViewState) => void;
  onRequestMode: (m: Mode) => void;
  reducedMotion: boolean;
}

const DRAG_THRESHOLD = 3;

type Editing = { kind: "node" | "edge"; id: string; draft: string };

interface PanDrag {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  origin: ViewState;
}

interface PinchGesture {
  ids: [number, number];
  startDist: number;
  startMid: { x: number; y: number };
  origin: ViewState;
}

type HandleDir = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
const HANDLES: HandleDir[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

export function Canvas({
  doc,
  selection,
  mode,
  input,
  dispatch,
  ghost,
  writeBuffer,
  writeGuide,
  justAddedId,
  cursor,
  cursor2,
  penDown,
  framePreview,
  view,
  onViewChange,
  onRequestMode,
  reducedMotion,
}: CanvasProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [size, setSize] = useState({ w: 1000, h: 700 });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [guides, setGuides] = useState<{ gx: number | null; gy: number | null }>({
    gx: null,
    gy: null,
  });
  const [spaceHeld, setSpaceHeld] = useState(false);

  const viewRef = useRef(view);
  viewRef.current = view;
  const sizeRef = useRef(size);
  sizeRef.current = size;

  // Track the container size so viewBox math stays exact.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ w: Math.max(1, r.width), h: Math.max(1, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const toScene = useCallback((clientX: number, clientY: number): Point => {
    const svg = svgRef.current;
    if (!svg) return { x: clientX, y: clientY };
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: clientX, y: clientY };
    const pt = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: pt.x, y: pt.y };
  }, []);

  // ----- camera: wheel zoom/pan (native listener; React's is passive) -----
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      const rect = svg.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.01);
        const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.z * factor));
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const sceneX = v.x + px / v.z;
        const sceneY = v.y + py / v.z;
        onViewChange({ x: sceneX - px / z, y: sceneY - py / z, z });
      } else {
        onViewChange({ x: v.x + e.deltaX / v.z, y: v.y + e.deltaY / v.z, z: v.z });
      }
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [onViewChange]);

  // Space = pan cursor (ignored while typing in the label editor).
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (e.code === "Space") setSpaceHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // ----- gesture bookkeeping (refs: no re-render per pointer event) -----
  const drag = useRef<{
    id: string;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const resize = useRef<{
    id: string;
    handle: HandleDir;
    start: Point;
    orig: { x: number; y: number; w: number; h: number };
    type: NodeType;
    moved: boolean;
  } | null>(null);
  const pan = useRef<PanDrag | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<PinchGesture | null>(null);
  const lastTap = useRef<{ kind: "node" | "edge"; id: string; t: number; x: number; y: number } | null>(null);

  // A mode switch mid-gesture must not leave a stroke or drag dangling.
  const cancelStroke = input.cancel;
  useEffect(() => {
    drag.current = null;
    resize.current = null;
    lastTap.current = null;
    setGuides({ gx: null, gy: null });
    cancelStroke();
  }, [mode, cancelStroke]);

  const nodesById = useMemo(() => new Map(doc.nodes.map((n) => [n.id, n])), [doc.nodes]);

  const commitLabel = useCallback(() => {
    setEditing((cur) => {
      if (!cur) return null;
      const label = cur.draft.trim();
      if (cur.kind === "edge") {
        dispatch({ type: "set-edge-label", id: cur.id, label });
      } else {
        const node = nodesById.get(cur.id);
        if (node && node.type === "text" && label === "") {
          dispatch({ type: "delete-node", id: cur.id }); // empty text box is invisible junk
        } else {
          dispatch({ type: "set-label", id: cur.id, label });
        }
      }
      return null;
    });
  }, [dispatch, nodesById]);

  const cancelEditing = useCallback(() => {
    setEditing((cur) => {
      if (cur && cur.kind === "node") {
        const node = nodesById.get(cur.id);
        if (node && node.type === "text" && node.label === "") {
          dispatch({ type: "delete-node", id: cur.id });
        }
      }
      return null;
    });
  }, [dispatch, nodesById]);

  const openNodeEditor = useCallback((node: DiagramNode) => {
    setEditing({ kind: "node", id: node.id, draft: node.label });
  }, []);

  const startPinchIfTwoPointers = useCallback(() => {
    if (pointers.current.size !== 2) return false;
    const [a, b] = [...pointers.current.entries()];
    if (!a || !b) return false;
    input.cancel();
    drag.current = null;
    resize.current = null;
    pan.current = null;
    pinch.current = {
      ids: [a[0], b[0]],
      startDist: Math.max(12, Math.hypot(a[1].x - b[1].x, a[1].y - b[1].y)),
      startMid: { x: (a[1].x + b[1].x) / 2, y: (a[1].y + b[1].y) / 2 },
      origin: viewRef.current,
    };
    return true;
  }, [input]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (editing) return;
      svgRef.current?.setPointerCapture(e.pointerId);
      if (e.pointerType === "touch") {
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (startPinchIfTwoPointers()) return;
      }

      // Panning wins in every mode: space-drag or middle button.
      if (spaceHeld || e.button === 1) {
        pan.current = {
          pointerId: e.pointerId,
          startClientX: e.clientX,
          startClientY: e.clientY,
          origin: viewRef.current,
        };
        return;
      }
      if (e.button !== 0 && e.pointerType !== "touch") return;

      const p = toScene(e.clientX, e.clientY);

      if (mode === "draw" || mode === "write") {
        input.begin(p);
        return;
      }

      if (mode === "text") {
        const id = uid("n");
        dispatch({
          type: "add-node",
          node: { id, type: "text", x: p.x - 80, y: p.y - 22, w: 160, h: 44, label: "" },
          select: true,
        });
        setEditing({ kind: "node", id, draft: "" });
        onRequestMode("select");
        return;
      }

      // ----- select mode -----
      drag.current = null;
      const target = e.target as Element;

      const handleEl = target.closest("[data-handle]");
      if (handleEl) {
        const id = handleEl.getAttribute("data-node-id")!;
        const node = nodesById.get(id);
        if (node) {
          resize.current = {
            id,
            handle: handleEl.getAttribute("data-handle") as HandleDir,
            start: p,
            orig: { x: node.x, y: node.y, w: node.w, h: node.h },
            type: node.type,
            moved: false,
          };
        }
        return;
      }

      const nodeEl = target.closest("[data-node-id]");
      const edgeEl = target.closest("[data-edge-id]");
      if (nodeEl) {
        const id = nodeEl.getAttribute("data-node-id")!;
        const node = nodesById.get(id);
        if (node) {
          const tap = lastTap.current;
          const isDouble =
            tap !== null &&
            tap.kind === "node" &&
            tap.id === id &&
            e.timeStamp - tap.t < 400 &&
            Math.hypot(p.x - tap.x, p.y - tap.y) < 12 / view.z;
          lastTap.current = { kind: "node", id, t: e.timeStamp, x: p.x, y: p.y };
          dispatch({ type: "select", selection: { kind: "node", id } });
          if (isDouble) {
            lastTap.current = null;
            openNodeEditor(node);
            return;
          }
          drag.current = {
            id,
            startX: p.x,
            startY: p.y,
            originX: node.x,
            originY: node.y,
            moved: false,
          };
        }
      } else if (edgeEl) {
        const id = edgeEl.getAttribute("data-edge-id")!;
        const tap = lastTap.current;
        const isDouble =
          tap !== null &&
          tap.kind === "edge" &&
          tap.id === id &&
          e.timeStamp - tap.t < 400 &&
          Math.hypot(p.x - tap.x, p.y - tap.y) < 12 / view.z;
        lastTap.current = { kind: "edge", id, t: e.timeStamp, x: p.x, y: p.y };
        dispatch({ type: "select", selection: { kind: "edge", id } });
        if (isDouble) {
          lastTap.current = null;
          const edge = doc.edges.find((ed) => ed.id === id);
          if (edge) setEditing({ kind: "edge", id, draft: edge.label ?? "" });
        }
      } else {
        lastTap.current = null;
        dispatch({ type: "select", selection: null });
      }
    },
    [
      editing,
      spaceHeld,
      mode,
      input,
      toScene,
      dispatch,
      nodesById,
      doc.edges,
      view.z,
      openNodeEditor,
      onRequestMode,
      startPinchIfTwoPointers,
    ],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (e.pointerType === "touch" && pointers.current.has(e.pointerId)) {
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const g = pinch.current;
        if (g) {
          const a = pointers.current.get(g.ids[0]);
          const b = pointers.current.get(g.ids[1]);
          if (a && b) {
            const rect = svgRef.current?.getBoundingClientRect();
            if (!rect) return;
            const dist = Math.max(12, Math.hypot(a.x - b.x, a.y - b.y));
            const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, g.origin.z * (dist / g.startDist)));
            const sceneMidX = g.origin.x + (g.startMid.x - rect.left) / g.origin.z;
            const sceneMidY = g.origin.y + (g.startMid.y - rect.top) / g.origin.z;
            onViewChange({
              x: sceneMidX - (mid.x - rect.left) / z,
              y: sceneMidY - (mid.y - rect.top) / z,
              z,
            });
          }
          return;
        }
      }

      const pn = pan.current;
      if (pn) {
        onViewChange({
          x: pn.origin.x - (e.clientX - pn.startClientX) / pn.origin.z,
          y: pn.origin.y - (e.clientY - pn.startClientY) / pn.origin.z,
          z: pn.origin.z,
        });
        return;
      }

      if (mode === "draw" || mode === "write") {
        if (input.live) input.extend(toScene(e.clientX, e.clientY));
        return;
      }
      if (mode !== "select") return;

      const rs = resize.current;
      if (rs) {
        if ((e.buttons & 1) === 0 && e.pointerType !== "touch") {
          resize.current = null;
          return;
        }
        const p = toScene(e.clientX, e.clientY);
        if (!rs.moved) {
          if (Math.hypot(p.x - rs.start.x, p.y - rs.start.y) < DRAG_THRESHOLD / view.z) return;
          rs.moved = true;
          dispatch({ type: "start-move", id: rs.id }); // one undo snapshot per resize
        }
        const dx = p.x - rs.start.x;
        const dy = p.y - rs.start.y;
        const min = minSizeFor(rs.type);
        let { x, y, w, h } = rs.orig;
        if (rs.handle.includes("e")) w = rs.orig.w + dx;
        if (rs.handle.includes("s")) h = rs.orig.h + dy;
        if (rs.handle.includes("w")) {
          w = rs.orig.w - dx;
          x = rs.orig.x + dx;
          if (w < min.w) {
            x = rs.orig.x + rs.orig.w - min.w;
            w = min.w;
          }
        }
        if (rs.handle.includes("n")) {
          h = rs.orig.h - dy;
          y = rs.orig.y + dy;
          if (h < min.h) {
            y = rs.orig.y + rs.orig.h - min.h;
            h = min.h;
          }
        }
        dispatch({ type: "resize-node", id: rs.id, x, y, w: Math.max(min.w, w), h: Math.max(min.h, h) });
        return;
      }

      const d = drag.current;
      if (!d) return;
      if ((e.buttons & 1) === 0 && e.pointerType !== "touch") {
        // Button released without a pointerup reaching us — never drag on hover.
        drag.current = null;
        setGuides({ gx: null, gy: null });
        return;
      }
      const p = toScene(e.clientX, e.clientY);
      if (!d.moved && Math.hypot(p.x - d.startX, p.y - d.startY) < DRAG_THRESHOLD / view.z) return;
      if (!d.moved) {
        d.moved = true;
        dispatch({ type: "start-move", id: d.id }); // one undo snapshot per drag
      }
      const node = nodesById.get(d.id);
      if (!node) return;
      const rawX = d.originX + (p.x - d.startX);
      const rawY = d.originY + (p.y - d.startY);
      const snapped = snapToAlignment(doc.nodes, d.id, rawX, rawY, node.w, node.h);
      setGuides({ gx: snapped.guideX, gy: snapped.guideY });
      dispatch({ type: "move-node", id: d.id, x: snapped.x, y: snapped.y });
    },
    [mode, input, toScene, dispatch, nodesById, doc.nodes, view.z, onViewChange],
  );

  const releasePointer = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (svgRef.current?.hasPointerCapture(e.pointerId)) {
      svgRef.current.releasePointerCapture(e.pointerId);
    }
    pointers.current.delete(e.pointerId);
    if (pinch.current && pointers.current.size < 2) pinch.current = null;
    if (pan.current?.pointerId === e.pointerId) pan.current = null;
  }, []);

  const endPointer = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const wasPinching = pinch.current !== null;
      releasePointer(e);
      drag.current = null;
      resize.current = null;
      setGuides({ gx: null, gy: null });
      if (input.live && !wasPinching) {
        if (mode === "draw" || mode === "write") input.end();
        else input.cancel();
      }
    },
    [mode, input, releasePointer],
  );

  // pointercancel (palm rejection, browser gesture, system overlay) must
  // discard the interrupted stroke, never run recognition on half of it.
  const cancelPointer = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      releasePointer(e);
      drag.current = null;
      resize.current = null;
      setGuides({ gx: null, gy: null });
      input.cancel();
    },
    [input, releasePointer],
  );

  const strokePath = (pts: readonly Point[]): string =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");

  const vw = size.w / view.z;
  const vh = size.h / view.z;
  const hairline = 1 / view.z;
  const selectedNode =
    selection?.kind === "node" ? (nodesById.get(selection.id) ?? null) : null;

  const editingNode = editing?.kind === "node" ? (nodesById.get(editing.id) ?? null) : null;
  const editingEdge = editing?.kind === "edge" ? doc.edges.find((e) => e.id === editing.id) : null;
  const editingEdgeMid = editingEdge ? edgeMidpoint(editingEdge, nodesById) : null;

  const cursorClass = spaceHeld
    ? "canvas--pan"
    : mode === "draw" || mode === "write"
      ? "canvas--draw"
      : mode === "text"
        ? "canvas--text"
        : "canvas--select";

  return (
    <svg
      ref={svgRef}
      className={`canvas ${cursorClass}`}
      viewBox={`${view.x} ${view.y} ${vw} ${vh}`}
      role="application"
      aria-label={`Plexus drawing surface, ${mode} mode`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={cancelPointer}
    >
      <defs>
        <pattern id="plexus-dots" width={22} height={22} patternUnits="userSpaceOnUse">
          <circle cx={1} cy={1} r={1} fill="var(--paper-dot)" />
        </pattern>
        <marker
          id="plexus-arrow-live"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--ink)" />
        </marker>
      </defs>

      <rect className="canvas__bg" x={view.x} y={view.y} width={vw} height={vh} fill="url(#plexus-dots)" />

      {/* Edges under nodes so arrowheads meet borders cleanly. */}
      <g>
        {doc.edges.map((edge) => (
          <EdgeView
            key={edge.id}
            edge={edge}
            nodesById={nodesById}
            selected={selection?.kind === "edge" && selection.id === edge.id}
            justAdded={justAddedId === edge.id && !reducedMotion}
            hideLabel={editing?.kind === "edge" && editing.id === edge.id}
          />
        ))}
      </g>

      <g>
        {doc.nodes.map((node) => (
          <NodeView
            key={node.id}
            node={node}
            selected={selection?.kind === "node" && selection.id === node.id}
            justAdded={justAddedId === node.id && !reducedMotion}
            editing={editing?.kind === "node" && editing.id === node.id}
          />
        ))}
      </g>

      {/* Alignment guides while dragging. */}
      {guides.gx !== null && (
        <line
          className="guide"
          x1={guides.gx}
          y1={view.y}
          x2={guides.gx}
          y2={view.y + vh}
          strokeWidth={hairline}
        />
      )}
      {guides.gy !== null && (
        <line
          className="guide"
          x1={view.x}
          y1={guides.gy}
          x2={view.x + vw}
          y2={guides.gy}
          strokeWidth={hairline}
        />
      )}

      {/* Resize handles for the selected node. */}
      {selectedNode && mode === "select" && !editing && (
        <ResizeHandles node={selectedNode} zoom={view.z} />
      )}

      {/* Ghost: the raw ink fading out as the clean content snaps in. */}
      {ghost &&
        !reducedMotion &&
        ghost.map((s, i) => (
          <path key={i} className="stroke-ghost" d={strokePath(s)} fill="none" />
        ))}

      {/* Write mode: baseline guide + buffered glyph strokes awaiting commit. */}
      {writeGuide && (
        <line
          className="write-guide"
          x1={writeGuide.x1}
          y1={writeGuide.y}
          x2={writeGuide.x2}
          y2={writeGuide.y}
          strokeWidth={hairline}
          strokeDasharray={`${5 / view.z} ${4 / view.z}`}
        />
      )}
      {writeBuffer.map((s, i) => (
        <path key={i} className="stroke-live stroke-live--pending" d={strokePath(s)} fill="none" />
      ))}

      {/* Live in-progress stroke. */}
      {input.live && input.live.length > 0 && (
        <path className="stroke-live" d={strokePath(input.live)} fill="none" />
      )}

      {/* Two-hand framing gesture preview. */}
      {framePreview && <FramePreviewView preview={framePreview} zoom={view.z} />}

      {/* Hand cursor reticles. */}
      {cursor && <Reticle p={cursor} down={penDown} zoom={view.z} />}
      {cursor2 && <Reticle p={cursor2} down={framePreview !== null} zoom={view.z} />}

      {/* Fill swatches for the selected shape node. */}
      {selectedNode && selectedNode.type !== "text" && mode === "select" && !editing && (
        <foreignObject
          x={selectedNode.x + selectedNode.w / 2 - 92 / view.z}
          y={selectedNode.y - 46 / view.z}
          width={184 / view.z}
          height={36 / view.z}
          className="fills-wrap"
          style={{ overflow: "visible" }}
        >
          <div
            className="fills"
            style={{ transform: `scale(${1 / view.z})`, transformOrigin: "0 0", width: 184 }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {FILL_SWATCHES.map((c) => (
              <button
                key={c || "auto"}
                type="button"
                className={`fills__chip ${c === "" ? "fills__chip--auto" : ""} ${
                  (selectedNode.fill ?? "") === c ? "fills__chip--on" : ""
                }`}
                style={c ? { background: c } : undefined}
                aria-label={c ? `Fill ${c}` : "Automatic fill (follows theme)"}
                title={c ? undefined : "Auto — follows the theme"}
                onClick={() => dispatch({ type: "set-fill", id: selectedNode.id, fill: c })}
              />
            ))}
          </div>
        </foreignObject>
      )}

      {editing && editingNode && (
        <LabelEditor
          x={editingNode.x}
          y={editingNode.y + editingNode.h / 2 - 16}
          width={Math.max(editingNode.w, 120)}
          draft={editing.draft}
          onChange={(draft) => setEditing((cur) => (cur ? { ...cur, draft } : cur))}
          onCommit={commitLabel}
          onCancel={cancelEditing}
        />
      )}
      {editing && editingEdgeMid && (
        <LabelEditor
          x={editingEdgeMid.x - 70}
          y={editingEdgeMid.y - 16}
          width={140}
          draft={editing.draft}
          onChange={(draft) => setEditing((cur) => (cur ? { ...cur, draft } : cur))}
          onCommit={commitLabel}
          onCancel={cancelEditing}
        />
      )}
    </svg>
  );
}

function edgeMidpoint(
  edge: DiagramEdge,
  nodesById: ReadonlyMap<string, DiagramNode>,
): Point | null {
  const r = routeEdge(edge, nodesById);
  if (!r) return null;
  return { x: (r.x1 + r.x2) / 2, y: (r.y1 + r.y2) / 2 };
}

const POLYGON_TYPES: ReadonlySet<NodeType> = new Set(["diamond", "triangle", "hexagon", "parallelogram"]);

function NodeView({
  node,
  selected,
  justAdded,
  editing,
}: {
  node: DiagramNode;
  selected: boolean;
  justAdded: boolean;
  editing: boolean;
}) {
  const cx = node.x + node.w / 2;
  const cy = node.y + node.h / 2;
  // Unfilled nodes omit the attribute so CSS's var(--node-fill) applies and
  // flips with the theme; explicit swatch fills persist as chosen.
  const fill = node.fill;
  const cls = `node node--${node.type} ${selected ? "node--selected" : ""} ${justAdded ? "node--snap" : ""}`;
  // Label editing opens via the double-press detection in onPointerDown —
  // pointer capture retargets native dblclick to the svg root, so a handler
  // here would never fire.
  return (
    <g className={cls} data-node-id={node.id}>
      {node.type === "ellipse" && (
        <ellipse className="node__shape" cx={cx} cy={cy} rx={node.w / 2} ry={node.h / 2} fill={fill} />
      )}
      {node.type === "rect" && (
        <rect className="node__shape" x={node.x} y={node.y} width={node.w} height={node.h} rx={8} fill={fill} />
      )}
      {POLYGON_TYPES.has(node.type) && (
        <polygon className="node__shape" points={shapePoints(node.type, node.x, node.y, node.w, node.h)} fill={fill} />
      )}
      {node.type === "cylinder" && (
        <>
          <path className="node__shape" d={cylinderPath(node.x, node.y, node.w, node.h)} fill={fill} />
          <ellipse
            className="node__lid"
            cx={cx}
            cy={node.y + cylinderCapRy(node.w, node.h)}
            rx={node.w / 2}
            ry={cylinderCapRy(node.w, node.h)}
            fill={fill}
          />
        </>
      )}
      {node.type === "text" && (
        <rect
          className="node__textbox"
          x={node.x}
          y={node.y}
          width={node.w}
          height={node.h}
          fill="transparent"
        />
      )}
      {!editing && node.label && (
        <text
          className="node__label"
          x={cx}
          y={cy}
          textAnchor="middle"
          dominantBaseline="central"
          style={node.fontSize ? { fontSize: node.fontSize } : undefined}
        >
          {node.label}
        </text>
      )}
      {node.type === "text" && !editing && !node.label && (
        <text className="node__label node__label--placeholder" x={cx} y={cy} textAnchor="middle" dominantBaseline="central">
          text
        </text>
      )}
    </g>
  );
}

function EdgeView({
  edge,
  nodesById,
  selected,
  justAdded,
  hideLabel,
}: {
  edge: DiagramEdge;
  nodesById: Map<string, DiagramNode>;
  selected: boolean;
  justAdded: boolean;
  hideLabel: boolean;
}) {
  const r = routeEdge(edge, nodesById);
  if (!r) return null;
  const midX = (r.x1 + r.x2) / 2;
  const midY = (r.y1 + r.y2) / 2;
  return (
    <g className={`edge ${selected ? "edge--selected" : ""} ${justAdded ? "edge--snap" : ""}`} data-edge-id={edge.id}>
      <line className="edge__hit" x1={r.x1} y1={r.y1} x2={r.x2} y2={r.y2} />
      <line
        className="edge__line"
        x1={r.x1}
        y1={r.y1}
        x2={r.x2}
        y2={r.y2}
        markerEnd={edge.arrow ? "url(#plexus-arrow-live)" : undefined}
      />
      {edge.label && !hideLabel && (
        <text className="edge__label" x={midX} y={midY} textAnchor="middle" dominantBaseline="central">
          {edge.label}
        </text>
      )}
    </g>
  );
}

function ResizeHandles({ node, zoom }: { node: DiagramNode; zoom: number }) {
  const s = 9 / zoom; // constant screen-size handles
  const half = s / 2;
  const xs = { w: node.x, c: node.x + node.w / 2, e: node.x + node.w };
  const ys = { n: node.y, c: node.y + node.h / 2, s: node.y + node.h };
  const pos: Record<HandleDir, [number, number]> = {
    nw: [xs.w, ys.n],
    n: [xs.c, ys.n],
    ne: [xs.e, ys.n],
    e: [xs.e, ys.c],
    se: [xs.e, ys.s],
    s: [xs.c, ys.s],
    sw: [xs.w, ys.s],
    w: [xs.w, ys.c],
  };
  return (
    <g className="handles">
      <rect
        className="handles__outline"
        x={node.x}
        y={node.y}
        width={node.w}
        height={node.h}
        strokeWidth={1 / zoom}
        strokeDasharray={`${4 / zoom} ${3 / zoom}`}
      />
      {HANDLES.map((h) => (
        <rect
          key={h}
          className={`handles__grip handles__grip--${h}`}
          data-handle={h}
          data-node-id={node.id}
          x={pos[h][0] - half}
          y={pos[h][1] - half}
          width={s}
          height={s}
          strokeWidth={1 / zoom}
        />
      ))}
    </g>
  );
}

function FramePreviewView({ preview, zoom }: { preview: FramePreview; zoom: number }) {
  const dash = `${6 / zoom} ${5 / zoom}`;
  const sw = 2 / zoom;
  const common = {
    className: "frame-preview",
    strokeWidth: sw,
    strokeDasharray: dash,
    fill: "var(--accent-soft)",
  } as const;
  if (preview.type === "ellipse") {
    return (
      <ellipse
        {...common}
        cx={preview.x + preview.w / 2}
        cy={preview.y + preview.h / 2}
        rx={preview.w / 2}
        ry={preview.h / 2}
      />
    );
  }
  if (POLYGON_TYPES.has(preview.type)) {
    return <polygon {...common} points={shapePoints(preview.type, preview.x, preview.y, preview.w, preview.h)} />;
  }
  if (preview.type === "cylinder") {
    return <path {...common} d={cylinderPath(preview.x, preview.y, preview.w, preview.h)} />;
  }
  return <rect {...common} x={preview.x} y={preview.y} width={preview.w} height={preview.h} rx={8} />;
}

function Reticle({ p, down, zoom }: { p: Point; down: boolean; zoom: number }) {
  return (
    <g className="reticle" transform={`translate(${p.x} ${p.y})`} aria-hidden="true">
      <circle
        className={`reticle__ring ${down ? "reticle__ring--down" : ""}`}
        r={(down ? 8 : 12) / zoom}
        strokeWidth={2 / zoom}
      />
      <circle className="reticle__dot" r={2 / zoom} />
    </g>
  );
}

function LabelEditor({
  x,
  y,
  width,
  draft,
  onChange,
  onCommit,
  onCancel,
}: {
  x: number;
  y: number;
  width: number;
  draft: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => clearTimeout(t);
  }, []);
  // Scene-space editor: it zooms with the canvas like everything else.
  return (
    <foreignObject x={x} y={y} width={width} height={34}>
      <input
        ref={inputRef}
        className="label-editor"
        value={draft}
        placeholder="label…"
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onCommit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
          e.stopPropagation();
        }}
      />
    </foreignObject>
  );
}
